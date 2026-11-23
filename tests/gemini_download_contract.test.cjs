const assert = require('node:assert/strict');
const {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const repoRoot = join(__dirname, '..');

const loadGeminiDownloadHelpers = (overrides = {}) => {
  const source = readFileSync(join(repoRoot, 'src', 'gemini_download.js'), 'utf8');
  const context = {
    console,
    module: { exports: {} },
    exports: {},
    process: {
      argv: ['node', 'token'],
      env: { ASK_BRIDGE_DOWNLOAD_NO_AUTORUN: '1' },
      pid: process.pid,
      exit: () => {},
    },
    require,
    Buffer,
    URL,
    AbortController,
    setTimeout: overrides.setTimeout || setTimeout,
    clearTimeout: overrides.clearTimeout || clearTimeout,
    fetch,
  };
  vm.runInNewContext(source, context, { filename: 'gemini_download.js' });
  return context.module.exports;
};

const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  return chunk;
}

function makeSyntheticPng(width = 2752, height = 1536, options = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    options.truncateIend ? iend.subarray(0, 8) : iend,
  ]);
}

function makeSyntheticJpeg(width = 2752, height = 1536, options = {}) {
  const fill = options.zeroFillBeforeSof ? Buffer.from([0xff, 0x00]) : Buffer.alloc(0);
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  const header = Buffer.concat([Buffer.from([0xff, 0xd8]), fill, sof]);
  header.writeUInt16BE(height, 2 + fill.length + 5);
  header.writeUInt16BE(width, 2 + fill.length + 7);
  return options.missingEoi
    ? header
    : Buffer.concat([header, Buffer.from([0xff, 0xd9])]);
}

function makeSyntheticWebp(width = 2752, height = 1536) {
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  const b1 = widthMinusOne & 0xff;
  const b2 = ((widthMinusOne >> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6);
  const b3 = (heightMinusOne >> 2) & 0xff;
  const b4 = (heightMinusOne >> 10) & 0x0f;
  const data = Buffer.from([0x2f, b1, b2, b3, b4]);
  const chunk = Buffer.alloc(8 + data.length + 1);
  chunk.write('VP8L', 0, 4, 'ascii');
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunk]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 4, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

function makeCdpSocket(handler) {
  const listeners = new Map();
  const socket = {
    readyState: 1,
    calls: [],
    closed: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type);
      if (set) set.delete(fn);
    },
    emit(type, event = {}) {
      for (const fn of [...(listeners.get(type) || [])]) fn(event);
    },
    emitMessage(value) {
      socket.emit('message', { data: JSON.stringify(value) });
    },
    close() {
      if (socket.closed) return;
      socket.closed = true;
      socket.readyState = 3;
      socket.emit('close', {});
    },
    send(raw) {
      const message = JSON.parse(raw);
      socket.calls.push(message);
      let outcome;
      try {
        outcome = handler(message, socket);
      } catch (error) {
        socket.emitMessage({ id: message.id, error: { message: error.message } });
        return;
      }
      const deliver = (result) => {
        if (result === undefined) return;
        queueMicrotask(() => socket.emitMessage({ id: message.id, result }));
      };
      if (outcome && typeof outcome.then === 'function') {
        outcome.then(deliver).catch((error) => {
          queueMicrotask(() => socket.emitMessage({
            id: message.id,
            error: { message: error && error.message ? error.message : String(error) },
          }));
        });
      } else {
        deliver(outcome);
      }
    },
  };
  return socket;
}

function makeFallbackError(reason) {
  const error = new Error(reason);
  error.fallbackReason = reason;
  error.fallbackEligible = true;
  return error;
}

function makeVerifySocket(candidates, options = {}) {
  return makeCdpSocket((message) => {
    if (message.method === 'Runtime.evaluate') {
      const expression = String((message.params && message.params.expression) || '');
      if (expression.includes('__ask_bridge_download_token ||')) {
        return { result: { value: options.token || 'token-1' } };
      }
      if (expression.includes('delete window.__ask_bridge_download_token')) {
        return { result: { value: true } };
      }
      return {
        result: {
          value: options.verifyOk === false
            ? { ok: false, reason: 'candidates_mismatch' }
            : { ok: true, candidates },
        },
      };
    }
    return {};
  });
}

function makeFullSizeHarness(candidate, options = {}) {
  const state = {
    behaviors: [],
    cancels: [],
    downloadPath: null,
    targetMethods: [],
    targetGetCalls: 0,
    targetSetDiscoverCalls: 0,
    clickCount: 0,
  };
  const browserWs = makeCdpSocket((message) => {
    state.targetMethods.push(message.method);
    if (message.method === 'Target.setDiscoverTargets') {
      state.targetSetDiscoverCalls += 1;
      if (options.targetDiscoveryUnsupported) throw new Error('Target.setDiscoverTargets unsupported');
      return {};
    }
    if (message.method === 'Target.getTargets') {
      state.targetGetCalls += 1;
      if (typeof options.onGetTargets === 'function') {
        return options.onGetTargets({ call: state.targetGetCalls, state });
      }
      return { targetInfos: options.targetInfos || [] };
    }
    if (message.method === 'Browser.setDownloadBehavior') {
      state.behaviors.push(message.params.behavior);
      if (message.params.behavior === 'allowAndName') {
        state.downloadPath = message.params.downloadPath;
      }
      return {};
    }
    if (message.method === 'Browser.cancelDownload') {
      state.cancels.push(message.params.guid);
      return {};
    }
    return {};
  });
  const pageWs = makeCdpSocket((message) => {
    state.targetMethods.push(message.method);
    if (message.method === 'Page.getFrameTree') {
      return {
        frameTree: {
          frame: {
            id: 'main-frame',
            childFrames: [{ frame: { id: 'child-frame' } }],
          },
        },
      };
    }
    if (message.method === 'Runtime.evaluate') {
      if (message.params && message.params.userGesture === true) {
        state.clickCount += 1;
        const clickResult = typeof options.clickResult === 'function'
          ? options.clickResult({ state })
          : options.clickResult;
        if (typeof options.onClick === 'function') {
          queueMicrotask(() => options.onClick({ browserWs, state }));
        }
        return { result: { value: clickResult || { ok: true } } };
      }
      const verifyResult = typeof options.verifyResult === 'function'
        ? options.verifyResult({ state })
        : options.verifyResult;
      return {
        result: {
          value: verifyResult || { ok: true, candidates: [candidate] },
        },
      };
    }
    return {};
  });
  return { pageWs, browserWs, state };
}

test('URL allowlist rejects http, private/loopback IPs, credentials, and untrusted hosts', () => {
  const helpers = loadGeminiDownloadHelpers();
  assert.equal(helpers.isAllowedGeminiImageUrl('https://lh3.googleusercontent.com/image.png').ok, true);
  assert.equal(helpers.isAllowedGeminiImageUrl('https://yt3.ggpht.com/image.png').ok, true);
  assert.equal(helpers.isAllowedGeminiImageUrl('https://gemini.google.com/u/0/image.png').ok, true);

  for (const bad of [
    'http://lh3.googleusercontent.com/image.png',
    'file:///etc/passwd',
    'https://user:pass@lh3.googleusercontent.com/image.png',
    'https://127.0.0.1/image.png',
    'https://10.0.0.1/image.png',
    'https://192.168.1.5/image.png',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/image.png',
    'https://localhost/image.png',
    'https://evil.example.com/image.png',
  ]) {
    assert.equal(helpers.isAllowedGeminiImageUrl(bad).ok, false, `should reject ${bad}`);
  }
});

test('blob URL origin check allows only https://gemini.google.com', () => {
  const helpers = loadGeminiDownloadHelpers();
  assert.equal(helpers.isAllowedGeminiBlobUrl('blob:https://gemini.google.com/1234-5678'), true);
  assert.equal(helpers.isAllowedGeminiBlobUrl('blob:https://evil.example.com/1234-5678'), false);
  assert.equal(helpers.isAllowedGeminiBlobUrl('blob:null/1234-5678'), false);
});

test('302 redirect to an untrusted mock server is blocked before request (untrusted receives 0 requests)', async () => {
  const helpers = loadGeminiDownloadHelpers();
  let untrustedRequests = 0;

  const untrustedServer = http.createServer((req, res) => {
    untrustedRequests += 1;
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(VALID_PNG);
  });
  await new Promise((resolve) => untrustedServer.listen(0, '127.0.0.1', resolve));
  const untrustedPort = untrustedServer.address().port;

  const trustedServer = http.createServer((req, res) => {
    if (req.url === '/redirect-evil') {
      res.writeHead(302, { Location: `http://127.0.0.1:${untrustedPort}/leak.png` });
      res.end();
      return;
    }
    if (req.url === '/redirect-ok') {
      res.writeHead(302, { Location: '/final.png' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(VALID_PNG);
  });
  await new Promise((resolve) => trustedServer.listen(0, '127.0.0.1', resolve));
  const trustedPort = trustedServer.address().port;
  const trustedOrigin = `http://127.0.0.1:${trustedPort}`;

  try {
    await assert.rejects(
      helpers.downloadWithManualRedirects(`${trustedOrigin}/redirect-evil`, {
        testTrustedOrigins: [trustedOrigin],
      }),
      /Blocked redirect target/,
    );
    assert.equal(untrustedRequests, 0, 'untrusted server must receive 0 requests');

    const ok = await helpers.downloadWithManualRedirects(`${trustedOrigin}/redirect-ok`, {
      testTrustedOrigins: [trustedOrigin],
    });
    assert.equal(ok.ext, 'png');
    assert.deepEqual(ok.buffer, VALID_PNG);
  } finally {
    await new Promise((resolve) => untrustedServer.close(resolve));
    await new Promise((resolve) => trustedServer.close(resolve));
  }
});

test('CDP cached resource path succeeds without calling fetch, and atomicWritePrivateFile uses 0600', async () => {
  const helpers = loadGeminiDownloadHelpers();
  const fakeCdp = {
    call: async (method) => {
      if (method === 'Page.getResourceContent') {
        return { content: VALID_PNG.toString('base64'), base64Encoded: true };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const cached = await helpers.tryReadCachedResourceViaCdp(
    fakeCdp,
    'frame-1',
    'https://lh3.googleusercontent.com/test.png',
  );
  assert.equal(cached.ext, 'png');
  assert.equal(cached.source, 'cdp_cached_resource');

  const dir = mkdtempSync(join(tmpdir(), 'gemini-dl-atomic-'));
  try {
    const target = join(dir, 'out.png');
    helpers.atomicWritePrivateFile(target, VALID_PNG);
    assert.deepEqual(readFileSync(target), VALID_PNG);
    assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V2-R1 & V2-R7: cross-origin redirect sends zero Cookie/Auth headers, enforces 3-redirect max, 30s deadline, pure magic bytes, non-public IP block, single-file path, and 2-phase publish rollback', async () => {
  const { writeFileSync, readdirSync } = require('node:fs');
  const helpers = loadGeminiDownloadHelpers();
  assert.equal(helpers.MAX_REDIRECTS, 3);
  assert.equal(helpers.REQUEST_TIMEOUT_MS, 30000);

  // V2-R1: Zero Cookie/Authorization across redirect hops between allowed hosts.
  const headersHostA = [];
  const headersHostB = [];
  const serverB = http.createServer((req, res) => {
    headersHostB.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(VALID_PNG);
  });
  await new Promise((resolve) => serverB.listen(0, '127.0.0.1', resolve));
  const portB = serverB.address().port;
  const originB = `http://127.0.0.1:${portB}`;

  const serverA = http.createServer((req, res) => {
    headersHostA.push(req.headers);
    res.writeHead(302, { Location: `${originB}/final.png` });
    res.end();
  });
  await new Promise((resolve) => serverA.listen(0, '127.0.0.1', resolve));
  const portA = serverA.address().port;
  const originA = `http://127.0.0.1:${portA}`;

  // >3 redirects server + fake PNG header server + slow trickle server.
  const redirectLoopServer = http.createServer((req, res) => {
    const hop = Number(new URL(req.url, originA).searchParams.get('hop') || '0');
    res.writeHead(302, { Location: `/?hop=${hop + 1}` });
    res.end();
  });
  await new Promise((resolve) => redirectLoopServer.listen(0, '127.0.0.1', resolve));
  const loopOrigin = `http://127.0.0.1:${redirectLoopServer.address().port}`;

  const fakePngServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from('<html>not a png</html>'));
  });
  await new Promise((resolve) => fakePngServer.listen(0, '127.0.0.1', resolve));
  const fakeOrigin = `http://127.0.0.1:${fakePngServer.address().port}`;

  const slowTimers = [];
  const slowServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.write(VALID_PNG.subarray(0, 4));
    const t = setInterval(() => {
      if (!res.writableEnded) res.write(Buffer.from([0x00]));
    }, 30);
    slowTimers.push(t);
  });
  await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
  const slowOrigin = `http://127.0.0.1:${slowServer.address().port}`;

  try {
    const dl = await helpers.fetchWithValidatedRedirects(`${originA}/start.png`, {
      testTrustedOrigins: [originA, originB],
    });
    assert.equal(dl.ext, 'png');
    assert.equal(headersHostA.length, 1);
    assert.equal(headersHostB.length, 1);
    assert.equal(headersHostA[0].cookie, undefined);
    assert.equal(headersHostA[0].authorization, undefined);
    assert.equal(headersHostB[0].cookie, undefined);
    assert.equal(headersHostB[0].authorization, undefined);

    await assert.rejects(
      helpers.fetchWithValidatedRedirects(`${loopOrigin}/?hop=0`, { testTrustedOrigins: [loopOrigin] }),
      /Too many redirects/,
    );

    const fakeRes = await helpers.fetchWithValidatedRedirects(`${fakeOrigin}/fake.png`, {
      testTrustedOrigins: [fakeOrigin],
    });
    assert.equal(fakeRes.ext, null);
    assert.equal(helpers.sniffImageExt(Buffer.from('<html></html>')), null);

    await assert.rejects(
      helpers.fetchWithValidatedRedirects(`${slowOrigin}/slow.png`, {
        testTrustedOrigins: [slowOrigin],
        timeoutMs: 80,
      }),
      /timed out/,
    );

    for (const nonPublicIp of [
      '192.0.2.1',
      '198.51.100.1',
      '203.0.113.1',
      '192.88.99.1',
      '2001:db8::1',
      '64:ff9b::127.0.0.1',
      '::ffff:7f00:1',
      '2002::1',
      'fe80::1',
    ]) {
      assert.equal(helpers.isPrivateOrLoopbackIp(nonPublicIp), true, `must block ${nonPublicIp}`);
    }

    // Single-file --image-output semantics
    assert.deepEqual(
      JSON.parse(JSON.stringify(helpers.resolveOutputFilePaths('/tmp/out/diagram.png', ['png']))),
      ['/tmp/out/diagram.png'],
    );
    const dirPaths = JSON.parse(JSON.stringify(helpers.resolveOutputFilePaths('/tmp/out/', ['png', 'jpg'])));
    assert.equal(dirPaths.length, 2);
    assert.match(dirPaths[0], /^\/tmp\/out\/generated_\d+_1\.png$/);

    // V2-R5: Two-phase batch download never leaks first image on 2nd failure & never overwrites existing output on after mismatch.
    const tmpOut = mkdtempSync(join(tmpdir(), 'gemini-dl-batch-'));
    try {
      const makeMockWs = (afterOk, candidates) => ({
        listeners: new Set(),
        addEventListener(_t, fn) { this.listeners.add(fn); },
        removeEventListener(_t, fn) { this.listeners.delete(fn); },
        send(raw) {
          const msg = JSON.parse(raw);
          const result = msg.method === 'Runtime.evaluate'
            ? { result: { value: afterOk ? { ok: true, candidates } : { ok: false, reason: 'candidates_mismatch' } } }
            : {};
          queueMicrotask(() => {
            for (const fn of [...this.listeners]) fn({ data: JSON.stringify({ id: msg.id, result }) });
          });
        },
      });
      const beforeFailSecond = {
        ok: true,
        candidates: [
          { artifactId: 'a1', src: `data:image/png;base64,${VALID_PNG.toString('base64')}`, naturalWidth: 1024, naturalHeight: 1024 },
          { artifactId: 'a2', src: 'https://evil.example.com/bad.png', naturalWidth: 1024, naturalHeight: 1024 },
        ],
      };
      await assert.rejects(
        () => helpers.downloadAndPublishBatch(makeMockWs(true, beforeFailSecond.candidates), beforeFailSecond, 'verify()', join(tmpOut, 'multi_dir')),
        /Blocked untrusted/,
      );
      assert.equal(readdirSync(tmpOut).includes('multi_dir'), false);

      const targetFile = join(tmpOut, 'diagram.png');
      writeFileSync(targetFile, Buffer.from('ORIGINAL_EXISTING_IMAGE'));
      const beforeIdentityChanged = {
        ok: true,
        candidates: [
          { artifactId: 'a1', src: `data:image/png;base64,${VALID_PNG.toString('base64')}`, naturalWidth: 1024, naturalHeight: 1024 },
        ],
      };
      const changedWs = makeMockWs(true, [
        { artifactId: 'a2', src: 'https://lh3.googleusercontent.com/swapped.png', naturalWidth: 1024, naturalHeight: 1024 },
      ]);
      await assert.rejects(
        () => helpers.downloadAndPublishBatch(changedWs, beforeIdentityChanged, 'verify()', targetFile),
        /Response identity changed/,
      );
      assert.equal(readFileSync(targetFile, 'utf8'), 'ORIGINAL_EXISTING_IMAGE');
      assert.deepEqual(JSON.parse(JSON.stringify(readdirSync(tmpOut))), ['diagram.png']);
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  } finally {
    for (const t of slowTimers) clearInterval(t);
    await Promise.all([
      new Promise((resolve) => serverA.close(resolve)),
      new Promise((resolve) => serverB.close(resolve)),
      new Promise((resolve) => redirectLoopServer.close(resolve)),
      new Promise((resolve) => fakePngServer.close(resolve)),
      new Promise((resolve) => slowServer.close(resolve)),
    ]);
  }
});

test('V3-R3/R4/R5: batch rollback preserves existing target on 2nd EISDIR failure, stdin handles >1.5 MiB identity, dim=256 unified, and slow 3xx/blob/cache respect per-image deadline', async () => {
  const { chmodSync, mkdirSync, readdirSync, writeFileSync } = require('node:fs');
  const { Readable } = require('node:stream');
  const helpers = loadGeminiDownloadHelpers();

  // 1. V3-R3: 2nd target is an existing directory -> EISDIR before touching 1st target, 1st target untouched!
  const tmpBatch = mkdtempSync(join(tmpdir(), 'gemini-v3-r3-'));
  try {
    const outDir = join(tmpBatch, 'out');
    mkdirSync(outDir, { recursive: true });
    // resolveOutputFilePaths('/dir/', ['png', 'png']) produces generated_<ts>_1.png and generated_<ts>_2.png,
    // so test with a directory that already exists at target #2 by mocking Date.now or testing both existing target #1 + directory #2.
    const origNow = Date.now;
    Date.now = () => 1700000000123;
    let target1;
    let target2Dir;
    try {
      [target1, target2Dir] = helpers.resolveOutputFilePaths(outDir + '/', ['png', 'png']);
    } finally {
      Date.now = origNow;
    }
    writeFileSync(target1, Buffer.from('ORIGINAL_TARGET_1_BYTES'));
    chmodSync(target1, 0o600);
    mkdirSync(target2Dir);

    const makeMockWs = (candidates) => ({
      listeners: new Set(),
      addEventListener(_t, fn) { this.listeners.add(fn); },
      removeEventListener(_t, fn) { this.listeners.delete(fn); },
      send(raw) {
        const msg = JSON.parse(raw);
        const result = msg.method === 'Runtime.evaluate'
          ? { result: { value: { ok: true, candidates } } }
          : {};
        queueMicrotask(() => {
          for (const fn of [...this.listeners]) fn({ data: JSON.stringify({ id: msg.id, result }) });
        });
      },
    });
    const before = {
      ok: true,
      candidates: [
        { artifactId: 'a1', src: `data:image/png;base64,${VALID_PNG.toString('base64')}`, naturalWidth: 1024, naturalHeight: 1024 },
        { artifactId: 'a2', src: `data:image/png;base64,${VALID_PNG.toString('base64')}`, naturalWidth: 1024, naturalHeight: 1024 },
      ],
    };
    const origNowBatch = Date.now;
    Date.now = () => 1700000000123;
    try {
      await assert.rejects(
        () => helpers.downloadAndPublishBatch(makeMockWs(before.candidates), before, 'verify()', outDir + '/'),
        /Refusing to overwrite non-regular target path/,
      );
    } finally {
      Date.now = origNowBatch;
    }
    assert.equal(readFileSync(target1, 'utf8'), 'ORIGINAL_TARGET_1_BYTES');
    assert.equal(statSync(target1).mode & 0o777, 0o600);
    assert.equal(statSync(target2Dir).isDirectory(), true);
    const { basename } = require('node:path');
    assert.deepEqual(readdirSync(outDir).sort(), [basename(target1), basename(target2Dir)].sort());
  } finally {
    rmSync(tmpBatch, { recursive: true, force: true });
  }

  // 1b. V3-R3: writeTempPrivateFile cleans up temp file if writeSync fails.
  const tmpWriteFail = mkdtempSync(join(tmpdir(), 'gemini-v3-r3-tmpfail-'));
  try {
    const fsMod = require('node:fs');
    const origWriteSync = fsMod.writeSync;
    fsMod.writeSync = () => { throw new Error('disk full'); };
    try {
      assert.throws(
        () => helpers.writeTempPrivateFile(tmpWriteFail, 'img.png', VALID_PNG),
        /disk full/,
      );
    } finally {
      fsMod.writeSync = origWriteSync;
    }
    assert.deepEqual(readdirSync(tmpWriteFail), []);
  } finally {
    rmSync(tmpWriteFail, { recursive: true, force: true });
  }

  // 2. V3-R4: >1.5 MiB data:image payload via stdin helper & unified 256px dimension threshold.
  assert.equal(helpers.MINIMUM_IMAGE_DIMENSION, 256);
  const largeDataUrl = `data:image/png;base64,${'A'.repeat(1600 * 1024)}`;
  const largeIdentity = JSON.stringify({
    turn_id: 'turn-1',
    conversation_id: 'conv-1',
    image_candidates: [{ artifact_id: 'a1', src: largeDataUrl, natural_width: 1024, natural_height: 1024 }],
  });
  const source = readFileSync(join(repoRoot, 'src', 'gemini_download.js'), 'utf8');
  const stdinStream = Readable.from([Buffer.from(largeIdentity.slice(0, 65536)), Buffer.from(largeIdentity.slice(65536))]);
  const stdinCtx = {
    console,
    module: { exports: {} },
    exports: {},
    process: { argv: ['node', 'tok', '/tmp/out.png', '-'], env: { ASK_BRIDGE_DOWNLOAD_NO_AUTORUN: '1' }, stdin: stdinStream, pid: process.pid, exit: () => {} },
    require,
    Buffer,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch,
  };
  vm.runInNewContext(source, stdinCtx, { filename: 'gemini_download.js' });
  const parsedFromStdin = await stdinCtx.module.exports.readExpectedIdentityPayload('-');
  assert.equal(parsedFromStdin.length, largeIdentity.length);

  // Verify 220x220 + 300x300 in buildVerifyProjectionExpression only selects 300x300 (dim=256).
  const verifyExpr = helpers.buildVerifyProjectionExpression({
    turn_id: 'turn-1',
    conversation_id: 'conversation:conv-1',
    image_candidates: [{ artifact_id: 'art-1', src: 'https://lh3.googleusercontent.com/300.png', natural_width: 300, natural_height: 300 }],
  });
  const genContainer = {
    tagName: 'GENERATED-IMAGE',
    getAttribute: (k) => (k === 'data-artifact-id' ? 'art-1' : ''),
    matches: (sel) => sel.includes('generated-image') || sel.includes('data-artifact-id'),
    closest: () => null,
    parentElement: null,
  };
  const smallImg = {
    tagName: 'IMG',
    complete: true,
    naturalWidth: 220,
    naturalHeight: 220,
    currentSrc: 'https://lh3.googleusercontent.com/220.png',
    src: 'https://lh3.googleusercontent.com/220.png',
    getAttribute: (k) => (k === 'src' ? 'https://lh3.googleusercontent.com/220.png' : ''),
    getBoundingClientRect: () => ({ width: 220, height: 220 }),
    parentElement: genContainer,
    closest: (sel) => (sel.includes('generated-image') || sel.includes('data-artifact-id') ? genContainer : null),
  };
  const largeImg = {
    tagName: 'IMG',
    complete: true,
    naturalWidth: 300,
    naturalHeight: 300,
    currentSrc: 'https://lh3.googleusercontent.com/300.png',
    src: 'https://lh3.googleusercontent.com/300.png',
    getAttribute: (k) => (k === 'src' ? 'https://lh3.googleusercontent.com/300.png' : ''),
    getBoundingClientRect: () => ({ width: 300, height: 300 }),
    parentElement: genContainer,
    closest: (sel) => (sel.includes('generated-image') || sel.includes('data-artifact-id') ? genContainer : null),
  };
  const turnEl = {
    getAttribute: (k) => (k === 'data-turn-id' ? 'turn-1' : ''),
    dataset: { turnId: 'turn-1' },
    querySelectorAll: (sel) => (sel.includes('img') ? [smallImg, largeImg] : []),
    closest: () => null,
  };
  const verifyResult = vm.runInNewContext(verifyExpr, {
    URL,
    window: {
      location: { origin: helpers.GEMINI_ORIGIN, pathname: '/app/conv-1', href: `${helpers.GEMINI_ORIGIN}/app/conv-1` },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    },
    document: {
      querySelector: () => null,
      querySelectorAll: (sel) => (sel.includes('model-response') ? [turnEl] : []),
    },
  });
  assert.equal(verifyResult.ok, true);
  assert.equal(verifyResult.candidates.length, 1);
  assert.equal(verifyResult.candidates[0].naturalWidth, 300);

  // 3. V3-R5: Slow 3xx redirect body is destroyed immediately after headers without hanging.
  let openRedirectSocket = null;
  const slowRedirectServer = http.createServer((req, res) => {
    if (req.url === '/slow-302') {
      openRedirectSocket = res.socket;
      res.writeHead(302, { Location: '/ok.png' });
      res.write('redirecting...');
      // Intentionally do NOT call res.end()!
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(VALID_PNG);
  });
  await new Promise((resolve) => slowRedirectServer.listen(0, '127.0.0.1', resolve));
  const slowRedirectOrigin = `http://127.0.0.1:${slowRedirectServer.address().port}`;
  try {
    const redirected = await helpers.fetchWithValidatedRedirects(`${slowRedirectOrigin}/slow-302`, {
      testTrustedOrigins: [slowRedirectOrigin],
      timeoutMs: 800,
    });
    assert.equal(redirected.ext, 'png');
    assert.deepEqual(redirected.buffer, VALID_PNG);
  } finally {
    if (openRedirectSocket && !openRedirectSocket.destroyed) openRedirectSocket.destroy();
    await new Promise((resolve) => slowRedirectServer.close(resolve));
  }

  // Slow blob/CDP cache read respects per-image timeout.
  const hangingWs = {
    listeners: new Set(),
    addEventListener(_t, fn) { this.listeners.add(fn); },
    removeEventListener(_t, fn) { this.listeners.delete(fn); },
    send() {},
  };
  await assert.rejects(
    () => helpers.readBlobDataUrlFromBrowser(hangingWs, 'blob:https://gemini.google.com/slow-1', 1024, 50),
    /timed out/,
  );
  await assert.rejects(
    () => helpers.tryReadCachedResourceViaCdp(hangingWs, 'https://lh3.googleusercontent.com/slow.png', 1024, 50),
    /timed out/,
  );
});

test('V4-R4: publish rollback restores both targets and reports retained backups when rollback itself fails', async () => {
  const fs = require('node:fs');
  const { chmodSync, mkdirSync, readdirSync, writeFileSync } = fs;
  const { basename } = require('node:path');
  const helpers = loadGeminiDownloadHelpers();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-v4-r4-'));
  const outDir = join(tmpRoot, 'out');
  mkdirSync(outDir, { recursive: true });

  try {
    const origNow = Date.now;
    Date.now = () => 1700000000123;
    let targets;
    try {
      targets = helpers.resolveOutputFilePaths(`${outDir}/`, ['png', 'png']);
    } finally {
      Date.now = origNow;
    }
    const originals = [Buffer.from('ORIGINAL_ONE'), Buffer.from('ORIGINAL_TWO')];
    writeFileSync(targets[0], originals[0]);
    writeFileSync(targets[1], originals[1]);
    chmodSync(targets[0], 0o640);
    chmodSync(targets[1], 0o600);

    const candidates = [
      { artifactId: 'a1', src: `data:image/png;base64,${VALID_PNG.toString('base64')}`, naturalWidth: 1024, naturalHeight: 1024 },
      { artifactId: 'a2', src: `data:image/png;base64,${VALID_PNG.toString('base64')}`, naturalWidth: 1024, naturalHeight: 1024 },
    ];
    const makeWs = () => ({
      listeners: new Set(),
      addEventListener(_type, fn) { this.listeners.add(fn); },
      removeEventListener(_type, fn) { this.listeners.delete(fn); },
      send(raw) {
        const msg = JSON.parse(raw);
        const result = msg.method === 'Runtime.evaluate'
          ? { result: { value: { ok: true, candidates } } }
          : {};
        queueMicrotask(() => {
          for (const fn of [...this.listeners]) fn({ data: JSON.stringify({ id: msg.id, result }) });
        });
      },
    });

    let promotions = 0;
    const successfulRollbackFs = {
      ...fs,
      renameSync(source, target) {
        if (basename(source).includes('.tmp-')) {
          promotions += 1;
          if (promotions === 2) {
            const err = new Error('EACCES: simulated second publish rename failure');
            err.code = 'EACCES';
            throw err;
          }
        }
        return fs.renameSync(source, target);
      },
    };
    await assert.rejects(
      () => helpers.downloadAndPublishBatch(
        makeWs(),
        { ok: true, candidates },
        'verify()',
        `${outDir}/`,
        { fsOps: successfulRollbackFs },
      ),
      /EACCES/,
    );
    assert.deepEqual(readFileSync(targets[0]), originals[0]);
    assert.deepEqual(readFileSync(targets[1]), originals[1]);
    assert.equal(statSync(targets[0]).mode & 0o777, 0o640);
    assert.equal(statSync(targets[1]).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(outDir).sort(), targets.map((target) => basename(target)).sort());

    promotions = 0;
    const rollbackFailureFs = {
      ...fs,
      renameSync(source, target) {
        const sourceName = basename(source);
        if (sourceName.includes('.tmp-')) {
          promotions += 1;
          if (promotions === 2) {
            const err = new Error('EACCES: simulated second publish rename failure');
            err.code = 'EACCES';
            throw err;
          }
        }
        if (sourceName.includes('.bak-') && target === targets[0]) {
          const err = new Error('EACCES: simulated backup restore failure');
          err.code = 'EACCES';
          throw err;
        }
        return fs.renameSync(source, target);
      },
    };
    let failure = null;
    try {
      await helpers.downloadAndPublishBatch(
        makeWs(),
        { ok: true, candidates },
        'verify()',
        `${outDir}/`,
        { fsOps: rollbackFailureFs },
      );
    } catch (err) {
      failure = err;
    }
    assert.ok(failure, 'publish must reject');
    assert.match(failure.message, /rollback was incomplete/);
    assert.equal(failure.publishError.code, 'EACCES');
    assert.equal(failure.rollbackFailures.length, 1);
    assert.equal(failure.rollbackFailures[0].action, 'restore_backup');
    assert.equal(failure.rollbackFailures[0].targetPath, targets[0]);
    assert.equal(failure.remainingBackups.length, 1);
    assert.equal(failure.uncleanedNewTargets.length, 0);
    const retained = failure.remainingBackups[0];
    assert.equal(retained.targetPath, targets[0]);
    assert.ok(fs.existsSync(retained.backupPath));
    assert.deepEqual(readFileSync(retained.backupPath), originals[0]);
    assert.match(failure.message, new RegExp(retained.backupPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(readFileSync(targets[1]), originals[1]);
    assert.deepEqual(
      readdirSync(outDir).sort(),
      [basename(targets[0]), basename(targets[1]), basename(retained.backupPath)].sort(),
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('V5-R3: runCli emits narrow rollback recovery JSON when publish and rollback both fail', async () => {
  const fs = require('node:fs');
  const { basename } = require('node:path');
  const helpers = loadGeminiDownloadHelpers();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-v5-r3-'));
  const target = join(tmpRoot, 'diagram.png');
  const original = Buffer.from('ORIGINAL_TARGET');
  fs.writeFileSync(target, original);
  const expectedIdentity = {
    turn_id: 'turn-rollback',
    conversation_id: 'conversation:rollback',
    assistant_count: 1,
    user_count: 1,
  };
  const candidates = [{
    artifactId: 'png-1',
    src: `data:image/png;base64,${VALID_PNG.toString('base64')}`,
    naturalWidth: 1024,
    naturalHeight: 1024,
  }];
  const listeners = new Map();
  const ws = {
    readyState: 1,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    emit(type, event = {}) {
      for (const fn of [...(listeners.get(type) || [])]) fn(event);
    },
    close() {
      this.readyState = 3;
      this.emit('close');
    },
    send(raw) {
      const msg = JSON.parse(raw);
      const expression = String((msg.params && msg.params.expression) || '');
      let result = {};
      if (expression.includes('__ask_bridge_download_token ||')) {
        result = { result: { value: 'token-1' } };
      } else if (expression.includes('const expected =')) {
        result = { result: { value: { ok: true, candidates } } };
      }
      queueMicrotask(() => this.emit('message', {
        data: JSON.stringify({ id: msg.id, result }),
      }));
    },
  };
  const rollbackFailureFs = {
    ...fs,
    renameSync(source, destination) {
      if (basename(source).includes('.tmp-')) {
        const error = new Error('EACCES: simulated publish failure');
        error.code = 'EACCES';
        throw error;
      }
      if (basename(source).includes('.bak-') && destination === target) {
        const error = new Error('EACCES: simulated rollback failure');
        error.code = 'EACCES';
        throw error;
      }
      return fs.renameSync(source, destination);
    },
  };
  const stdout = [];
  let stdoutFlushed = false;
  const stdoutStream = {
    write(value, callback) {
      stdout.push(value);
      setTimeout(() => {
        stdoutFlushed = true;
        callback(null);
      }, 15);
      return false;
    },
  };
  try {
    let failure = null;
    try {
      await helpers.runCli({
        tokenArg: 'token-1',
        outputArg: target,
        expectedIdentityJsonArg: JSON.stringify(expectedIdentity),
        fetch: async () => ({
          json: async () => [{ type: 'page', url: `${helpers.GEMINI_ORIGIN}/app/rollback`, webSocketDebuggerUrl: 'ws://test' }],
        }),
        WebSocketCtor: function FakeWebSocket() { return ws; },
        cleanupTimeoutMs: 40,
        overallLimitMs: 1500,
        onWatchdogExit: () => {},
        writeStdout: (value) => helpers.writeStreamFlushed(stdoutStream, value),
        fsOps: rollbackFailureFs,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'runCli must reject when publish rollback is incomplete');
    assert.equal(stdoutFlushed, true);
    assert.equal(stdout.length, 1);
    const structured = JSON.parse(stdout[0]);
    assert.equal(structured.ok, false);
    assert.equal(structured.error, 'publish_rollback_incomplete');
    assert.equal(structured.remaining_backups.length, 1);
    assert.equal(structured.remaining_backups[0].target_path, target);
    assert.match(structured.remaining_backups[0].backup_path, /\.diagram\.png\.bak-/);
    assert.deepEqual(structured.uncleaned_targets, []);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('V6-R2: writeStreamFlushed waits for the backpressure write callback', async () => {
  const helpers = loadGeminiDownloadHelpers();
  let flushed = false;
  let writes = 0;
  const stream = {
    write(_value, callback) {
      writes += 1;
      setTimeout(() => {
        flushed = true;
        callback(null);
      }, 25);
      return false;
    },
  };

  const pending = helpers.writeStreamFlushed(stream, 'payload').then(() => {
    flushed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(writes, 1);
  assert.equal(flushed, false);
  await pending;
  assert.equal(flushed, true);
});

test('V4-R7: runCli bounds blob and post-publish verification CDP waits, cleans temps, closes socket, and never awaits watchdog', async () => {
  const fs = require('node:fs');
  const { existsSync, mkdirSync, readdirSync } = fs;
  const helpers = loadGeminiDownloadHelpers();
  const expectedIdentity = {
    turn_id: 'turn-shared',
    conversation_id: 'conversation:conv-1',
    assistant_count: 1,
    user_count: 1,
  };

  const makeTransport = (candidates) => {
    const ws = {
      readyState: 1,
      listeners: new Map(),
      calls: [],
      closed: false,
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        if (this.listeners.has(type)) this.listeners.get(type).delete(fn);
      },
      emit(type, event = {}) {
        for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
      },
      close() {
        this.closed = true;
        this.readyState = 3;
        this.emit('close');
      },
      send(raw) {
        const msg = JSON.parse(raw);
        this.calls.push(msg);
        if (msg.method === 'Page.enable') {
          queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: msg.id, result: {} }) }));
          return;
        }
        const expression = String((msg.params && msg.params.expression) || '');
        if (expression.includes('__ask_bridge_download_token ||')) {
          queueMicrotask(() => this.emit('message', {
            data: JSON.stringify({ id: msg.id, result: { result: { value: 'token-1' } } }),
          }));
          return;
        }
        if (expression.includes('delete window.__ask_bridge_download_token')) return;
        if (expression.includes('const expected =')) {
          const verifies = this.calls.filter((call) => String((call.params && call.params.expression) || '').includes('const expected =')).length;
          if (verifies === 1) {
            queueMicrotask(() => this.emit('message', {
              data: JSON.stringify({ id: msg.id, result: { result: { value: { ok: true, candidates } } } }),
            }));
          }
          return;
        }
        if (expression.includes('fetch(blob:')) return;
      },
      listenerCount() {
        return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
      },
    };
    return ws;
  };

  const tmpA = mkdtempSync(join(tmpdir(), 'gemini-v4-r7-a-'));
  try {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      artifactId: `blob-${index}`,
      src: `blob:https://gemini.google.com/hanging-${index}`,
      naturalWidth: 1024,
      naturalHeight: 1024,
    }));
    const ws = makeTransport(candidates);
    let watchdogFired = false;
    const stdout = [];
    const startedAt = Date.now();
    await assert.rejects(
      () => helpers.runCli({
        tokenArg: 'token-1',
        outputArg: `${tmpA}/out/`,
        expectedIdentityJsonArg: JSON.stringify(expectedIdentity),
        fetch: async () => ({ json: async () => [{ type: 'page', url: `${helpers.GEMINI_ORIGIN}/app/conv-1`, webSocketDebuggerUrl: 'ws://test' }] }),
        WebSocketCtor: function FakeWebSocket() { return ws; },
        timeoutMs: 80,
        verifyTimeoutMs: 60,
        cleanupTimeoutMs: 40,
        overallLimitMs: 1500,
        onWatchdogExit: () => { watchdogFired = true; },
        writeStdout: (value) => stdout.push(value),
      }),
      /Response identity could not be re-verified/,
    );
    assert.ok(Date.now() - startedAt < 1000, 'runCli must finish well below the watchdog');
    assert.equal(watchdogFired, false);
    assert.equal(ws.closed, true);
    assert.equal(ws.listenerCount(), 0);
    assert.deepEqual(stdout, []);
    assert.deepEqual(existsSync(`${tmpA}/out/`) ? readdirSync(`${tmpA}/out/`) : [], []);
  } finally {
    rmSync(tmpA, { recursive: true, force: true });
  }

  const tmpB = mkdtempSync(join(tmpdir(), 'gemini-v4-r7-b-'));
  try {
    const outputDir = join(tmpB, 'out');
    mkdirSync(outputDir, { recursive: true });
    const candidates = [{
      artifactId: 'png-1',
      src: `data:image/png;base64,${VALID_PNG.toString('base64')}`,
      naturalWidth: 1024,
      naturalHeight: 1024,
    }];
    const ws = makeTransport(candidates);
    let watchdogFired = false;
    const stdout = [];
    const startedAt = Date.now();
    await assert.rejects(
      () => helpers.runCli({
        tokenArg: 'token-1',
        outputArg: join(outputDir, 'diagram.png'),
        expectedIdentityJsonArg: JSON.stringify(expectedIdentity),
        fetch: async () => ({ json: async () => [{ type: 'page', url: `${helpers.GEMINI_ORIGIN}/app/conv-1`, webSocketDebuggerUrl: 'ws://test' }] }),
        WebSocketCtor: function FakeWebSocket() { return ws; },
        timeoutMs: 100,
        verifyTimeoutMs: 60,
        cleanupTimeoutMs: 40,
        overallLimitMs: 1500,
        onWatchdogExit: () => { watchdogFired = true; },
        writeStdout: (value) => stdout.push(value),
      }),
      /Response identity could not be re-verified/,
    );
    assert.ok(Date.now() - startedAt < 1000, 'runCli must finish well below the watchdog');
    assert.equal(watchdogFired, false);
    assert.equal(ws.closed, true);
    assert.equal(ws.listenerCount(), 0);
    assert.deepEqual(stdout, []);
    assert.deepEqual(readdirSync(outputDir), []);
    assert.equal(fs.existsSync(join(outputDir, 'diagram.png')), false);
  } finally {
    rmSync(tmpB, { recursive: true, force: true });
  }
});

test('V4-R5: shared turn grouping keeps two model-response fragments in one data-turn-key for download verification', () => {
  const helpers = loadGeminiDownloadHelpers();
  const projection = require('../src/gemini_turn_projection.js');

  const turnScope = {
    tagName: 'DIV',
    getAttribute(name) { return name === 'data-turn-key' ? 'turn-shared' : ''; },
    closest(selector) { return selector === '[data-turn-key]' ? this : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const makeResponse = (id, text) => ({
    tagName: 'MODEL-RESPONSE',
    textContent: text,
    innerHTML: text,
    children: [],
    childNodes: [],
    classList: [],
    getAttribute(name) { return name === 'data-response-id' ? id : ''; },
    closest(selector) {
      if (selector === 'model-response') return this;
      if (selector === '[data-turn-key]') return turnScope;
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect: () => ({ width: 600, height: 100 }),
  });
  const responseOne = makeResponse('resp-1', 'first fragment');
  const responseTwo = makeResponse('resp-2', 'second fragment');
  const userQuery = {
    tagName: 'USER-QUERY',
    textContent: 'draw it',
    closest(selector) { return selector === '[data-turn-key]' ? turnScope : null; },
    querySelectorAll() { return []; },
  };
  const generatedContainer = {
    tagName: 'GENERATED-IMAGE',
    parentElement: responseTwo,
    getAttribute(name) { return name === 'data-artifact-id' ? 'art-1' : ''; },
    matches: () => false,
    closest: () => null,
    querySelectorAll() { return []; },
  };
  const generatedImage = {
    tagName: 'IMG',
    complete: true,
    naturalWidth: 512,
    naturalHeight: 512,
    currentSrc: 'https://lh3.googleusercontent.com/generated-1.png',
    src: 'https://lh3.googleusercontent.com/generated-1.png',
    parentElement: generatedContainer,
    getAttribute(name) { return name === 'src' ? this.src : ''; },
    getBoundingClientRect: () => ({ width: 512, height: 512 }),
    closest: () => null,
  };
  responseTwo.querySelectorAll = (selector) => (String(selector).includes('generated-image') ? [generatedImage] : []);
  turnScope.querySelectorAll = (selector) => {
    if (String(selector).includes('[data-response-id]') || String(selector).includes('[data-artifact-id]')) {
      return [responseOne, responseTwo, generatedContainer];
    }
    return [];
  };
  const document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === 'model-response') return [responseOne, responseTwo];
      if (selector === 'user-query') return [userQuery];
      return [];
    },
  };

  const groups = projection.geminiTurnGroups(document, projection.GEMINI_ASSISTANT_SELECTOR);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].nodes.length, 2);

  const expression = helpers.buildVerifyProjectionExpression({
    turn_id: 'turn-shared',
    conversation_id: 'conversation:conv-1',
    user_count: 1,
    assistant_count: 1,
    artifact_ids: ['art-1', 'resp-1', 'resp-2'],
    image_candidates: [{
      artifact_id: 'art-1',
      src: 'https://lh3.googleusercontent.com/generated-1.png',
      natural_width: 512,
      natural_height: 512,
    }],
  });
  const result = vm.runInNewContext(expression, {
    URL,
    window: {
      location: { origin: helpers.GEMINI_ORIGIN, pathname: '/app/conv-1', href: `${helpers.GEMINI_ORIGIN}/app/conv-1` },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    },
    document,
  });
  assert.equal(result.ok, true);
  assert.equal(result.turnId, 'turn-shared');
  assert.deepEqual(Array.from(result.artifactIds), ['art-1', 'resp-1', 'resp-2']);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].artifactId, 'art-1');
  assert.equal(result.candidates[0].src, 'https://lh3.googleusercontent.com/generated-1.png');
});

test('full-size download allowlist accepts only single-label usercontent.google.com while rejecting nested hosts and unsafe schemes', () => {
  const helpers = loadGeminiDownloadHelpers();

  assert.equal(helpers.isAllowedGeminiImageUrl('https://abc.usercontent.google.com/download').ok, true);
  assert.equal(helpers.isAllowedGeminiImageUrl('https://usercontent.google.com/download').ok, false);
  assert.equal(helpers.isAllowedGeminiImageUrl('https://a.b.usercontent.google.com/download').ok, false);
  assert.equal(helpers.isAllowedGeminiDownloadEventUrl('https://abc.usercontent.google.com/download'), true);
  assert.equal(helpers.isAllowedGeminiDownloadEventUrl('https://lh3.googleusercontent.com/download'), true);
  assert.equal(helpers.isAllowedGeminiDownloadEventUrl('blob:https://gemini.google.com/1234'), true);
  assert.equal(helpers.isAllowedGeminiDownloadEventUrl('blob:null/1234-5678'), false);
  assert.equal(helpers.isAllowedGeminiDownloadEventUrl('blob:null/1234-5678', { allowOwnedSandboxedBlob: true }), true);
  assert.equal(helpers.isAllowedGeminiDownloadEventUrl('data:image/png;base64,AAAA'), true);

  for (const blocked of [
    'http://abc.usercontent.google.com/download',
    'https://evil.example.com/download',
    'https://a.b.usercontent.google.com/download',
    'https://user:secret@abc.usercontent.google.com/download',
    'javascript:alert(1)',
    'blob:https://evil.example.com/1234',
    'blob:null/',
    'blob:null/1234/extra',
    'blob:null/1234?download=1',
    'blob:null/1234#fragment',
    'blob:null/../escape',
    'blob:null/1234_5678',
  ]) {
    assert.equal(helpers.isAllowedGeminiDownloadEventUrl(blocked), false, `must reject ${blocked}`);
    assert.equal(
      helpers.isAllowedGeminiDownloadEventUrl(blocked, { allowOwnedSandboxedBlob: true }),
      false,
      `sandbox override must still reject ${blocked}`,
    );
  }

  const source = readFileSync(join(repoRoot, 'src', 'gemini_download.js'), 'utf8');
  assert.equal(source.includes('node:zlib'), false);
  assert.equal(source.includes('inflateSync'), false);
});

test('collectOwnedIframeTargets follows same-context iframe parent chains and marks only sandboxed child targets', () => {
  const helpers = loadGeminiDownloadHelpers();
  const result = helpers.collectOwnedIframeTargets([
    { targetId: 'main-frame', type: 'page', url: 'https://gemini.google.com/app', browserContextId: 'ctx-owned' },
    { targetId: 'owned-srcdoc', type: 'iframe', parentFrameId: 'main-frame', url: 'about:srcdoc', browserContextId: 'ctx-owned' },
    { targetId: 'owned-blank', type: 'iframe', parentId: 'owned-srcdoc', url: 'about:blank', browserContextId: 'ctx-owned' },
    { targetId: 'owned-data', type: 'iframe', parentFrameId: 'main-frame', url: 'data:text/html;charset=utf-8,<p>x</p>', browserContextId: 'ctx-owned' },
    { targetId: 'owned-https', type: 'iframe', parentFrameId: 'main-frame', url: 'https://example.com/frame', browserContextId: 'ctx-owned' },
    { targetId: 'foreign-frame', type: 'iframe', parentFrameId: 'foreign-page', url: 'about:srcdoc', browserContextId: 'ctx-owned' },
    { targetId: 'other-context', type: 'iframe', parentFrameId: 'main-frame', url: 'about:srcdoc', browserContextId: 'ctx-other' },
    { targetId: 'loop-a', type: 'iframe', parentId: 'loop-b', url: 'about:blank', browserContextId: 'ctx-owned' },
    { targetId: 'loop-b', type: 'iframe', parentId: 'loop-a', url: 'about:blank', browserContextId: 'ctx-owned' },
  ], ['main-frame'], 'ctx-owned');

  assert.deepEqual(Array.from(result.ownedTargetIds).sort(), ['owned-blank', 'owned-data', 'owned-https', 'owned-srcdoc']);
  assert.deepEqual(Array.from(result.sandboxedIframeIds).sort(), ['owned-blank', 'owned-data', 'owned-srcdoc']);
});

test('validateImageHeaderAndTrailer checks PNG IHDR+IEND, JPEG SOF+EOI, WebP RIFF dimensions, and size bounds without decoding pixels', () => {
  const helpers = loadGeminiDownloadHelpers();

  const png = makeSyntheticPng(2752, 1536);
  const pngResult = helpers.validateImageHeaderAndTrailer(png, 256);
  assert.deepEqual(JSON.parse(JSON.stringify(pngResult)), {
    ok: true,
    ext: 'png',
    width: 2752,
    height: 1536,
  });
  assert.equal(
    helpers.validateImageHeaderAndTrailer(makeSyntheticPng(2752, 1536, { truncateIend: true }), 256).reason,
    'invalid_png_trailer',
  );
  assert.equal(
    helpers.validateImageHeaderAndTrailer(makeSyntheticPng(200, 200), 256).reason,
    'image_below_minimum_dimension',
  );

  const jpegResult = helpers.validateImageHeaderAndTrailer(makeSyntheticJpeg(2752, 1536), 256);
  assert.equal(jpegResult.ok, true);
  assert.equal(jpegResult.ext, 'jpg');
  assert.equal(jpegResult.width, 2752);
  assert.equal(jpegResult.height, 1536);
  const zeroFilledJpeg = helpers.validateImageHeaderAndTrailer(
    makeSyntheticJpeg(2752, 1536, { zeroFillBeforeSof: true }),
    256,
  );
  assert.equal(zeroFilledJpeg.ok, true);
  assert.equal(zeroFilledJpeg.width, 2752);
  assert.equal(zeroFilledJpeg.height, 1536);
  assert.equal(
    helpers.validateImageHeaderAndTrailer(makeSyntheticJpeg(2752, 1536, { missingEoi: true }), 256).reason,
    'invalid_jpeg_trailer',
  );
  assert.equal(
    helpers.validateImageHeaderAndTrailer(makeSyntheticJpeg(200, 200), 256).reason,
    'image_below_minimum_dimension',
  );

  const webpResult = helpers.validateImageHeaderAndTrailer(makeSyntheticWebp(2752, 1536), 256);
  assert.equal(webpResult.ok, true);
  assert.equal(webpResult.ext, 'webp');
  assert.equal(webpResult.width, 2752);
  assert.equal(webpResult.height, 1536);
  assert.equal(
    helpers.validateImageHeaderAndTrailer(makeSyntheticWebp(200, 200), 256).reason,
    'image_below_minimum_dimension',
  );

  assert.equal(helpers.validateImageHeaderAndTrailer(Buffer.alloc(0), 256).reason, 'invalid_image_size');
  assert.equal(
    helpers.validateImageHeaderAndTrailer(Buffer.alloc(helpers.MAX_IMAGE_BYTES + 1), 256).reason,
    'invalid_image_size',
  );
});

test('connectBrowserCdp requires a loopback browser websocket and treats non-object mocks as unsupported', async () => {
  const helpers = loadGeminiDownloadHelpers();

  for (const allowed of [
    'ws://127.0.0.1:9223/devtools/browser/browser-1',
    'ws://localhost:9223/devtools/browser/browser-1',
    'ws://[::1]:9223/devtools/browser/browser-1',
  ]) {
    assert.equal(helpers.isLoopbackBrowserWsUrl(allowed), true, allowed);
  }
  for (const blocked of [
    'ws://127.0.0.1:9222/devtools/browser/browser-1',
    'ws://127.0.0.1:9223/devtools/page/page-1',
    'ws://127.0.0.1:9223/json/version',
    'wss://127.0.0.1:9223/devtools/browser/browser-1',
    'ws://evil.example.com:9223/devtools/browser/browser-1',
    'ws://user:pass@127.0.0.1:9223/devtools/browser/browser-1',
  ]) {
    assert.equal(helpers.isLoopbackBrowserWsUrl(blocked), false, blocked);
  }

  await assert.rejects(
    () => helpers.connectBrowserCdp({ fetch: async () => ({ json: async () => [] }) }),
    (error) => {
      assert.equal(error.fallbackReason, 'cdp_download_behavior_unsupported');
      assert.equal(error.fallbackEligible, true);
      return true;
    },
  );
  await assert.rejects(
    () => helpers.connectBrowserCdp({ fetch: async () => ({ json: async () => 'not-an-object' }) }),
    (error) => {
      assert.equal(error.fallbackReason, 'cdp_download_behavior_unsupported');
      assert.equal(error.fallbackEligible, true);
      return true;
    },
  );
  await assert.rejects(
    () => helpers.connectBrowserCdp({
      fetch: async () => ({
        json: async () => ({ webSocketDebuggerUrl: 'ws://evil.example.com:9223/devtools/browser/browser-1' }),
      }),
    }),
    (error) => {
      assert.equal(error.fallbackEligible, false);
      assert.match(error.message, /loopback/);
      return true;
    },
  );

  class OpenWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      queueMicrotask(() => this.emit('open'));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      const set = this.listeners.get(type);
      if (set) set.delete(fn);
    }
    emit(type) {
      for (const fn of [...(this.listeners.get(type) || [])]) fn({});
    }
    close() {}
  }
  const connected = await helpers.connectBrowserCdp({
    fetch: async () => ({
      json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/browser/browser-1' }),
    }),
    WebSocketCtor: OpenWebSocket,
  });
  assert.equal(connected.wsUrl, 'ws://127.0.0.1:9223/devtools/browser/browser-1');
  assert.equal(connected.ws.url, connected.wsUrl);
});

// --- Gemini full-size download contracts ---

function makeRunCliHarness(candidates, options = {}) {
  const state = { behaviors: [], cancels: [], downloadPath: null, clickCount: 0 };
  const browserWs = makeCdpSocket((message) => {
    if (message.method === 'Browser.setDownloadBehavior') {
      state.behaviors.push(message.params.behavior);
      if (message.params.behavior === 'allowAndName') {
        state.downloadPath = message.params.downloadPath;
      }
      return {};
    }
    if (message.method === 'Browser.cancelDownload') {
      state.cancels.push(message.params.guid);
      return {};
    }
    return {};
  });
  const pageWs = makeCdpSocket((message) => {
    if (message.method === 'Page.enable') return {};
    if (message.method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'main-frame', childFrames: [] } } };
    }
    if (message.method !== 'Runtime.evaluate') return {};
    const expression = String((message.params && message.params.expression) || '');
    if (expression.includes('__ask_bridge_download_token ||')) {
      return { result: { value: options.token || 'token-1' } };
    }
    if (expression.includes('delete window.__ask_bridge_download_token')) {
      return { result: { value: true } };
    }
    if (message.params && message.params.userGesture === true) {
      state.clickCount += 1;
      const clickResult = typeof options.clickResult === 'function'
        ? options.clickResult({ state })
        : options.clickResult;
      if (typeof options.onClick === 'function') {
        queueMicrotask(() => options.onClick({ browserWs, state }));
      }
      return { result: { value: clickResult || { ok: true } } };
    }
    const verifyResult = typeof options.verifyResult === 'function'
      ? options.verifyResult({ state })
      : options.verifyResult;
    return { result: { value: verifyResult || { ok: true, candidates } } };
  });
  return { pageWs, browserWs, state };
}

function makeRunCliFetch(origin) {
  return async () => ({
    json: async () => [{
      type: 'page',
      url: `${origin}/app/full-size-contract`,
      webSocketDebuggerUrl: 'ws://page-test',
    }],
  });
}

function makeFullSizeCandidate(index = 1, overrides = {}) {
  const preview = makeSyntheticPng(2752, 1536);
  return {
    artifactId: `generated-image-${index}`,
    src: `data:image/png;base64,${preview.toString('base64')}`,
    naturalWidth: 2752,
    naturalHeight: 1536,
    ...overrides,
  };
}

function fullSizeIdentity() {
  return { turn_id: 'turn-1', conversation_id: 'conversation:full-size' };
}

function emitDownloadEvent(browserWs, method, params) {
  browserWs.emitMessage({ method, params });
}

function beginOwnedDownload(browserWs, guid = 'guid-1', frameId = 'main-frame', url = 'https://abc.usercontent.google.com/download?id=1') {
  emitDownloadEvent(browserWs, 'Browser.downloadWillBegin', { frameId, guid, url });
}

function completeOwnedDownload(browserWs, guid = 'guid-1') {
  emitDownloadEvent(browserWs, 'Browser.downloadProgress', {
    guid,
    state: 'completed',
    receivedBytes: 100,
    totalBytes: 100,
  });
}

function assertFailClosed(error, pattern, exitCode) {
  assert.ok(error && typeof error.message === 'string');
  assert.equal(error.fallbackEligible, false, error.message);
  if (exitCode !== undefined) assert.equal(error.exitCode, exitCode, error.message);
  assert.match(error.message, pattern);
  return true;
}

function makeFakeTimerHarness() {
  const delays = [];
  const timers = new Map();
  let nextId = 1;
  return {
    delays,
    setTimeout(fn, ms) {
      const timer = { id: nextId, fn, ms };
      nextId += 1;
      delays.push(ms);
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timers.delete(timer.id);
    },
  };
}

test('full-size download saves a 2752x1536 PNG disguised as .jpeg as .png and reports full_size_download', async () => {
  const helpers = loadGeminiDownloadHelpers();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-success-'));
  try {
    const candidate = makeFullSizeCandidate(1);
    const expectedBytes = makeSyntheticPng(2752, 1536);
    const harness = makeFullSizeHarness(candidate, {
      onClick({ browserWs, state }) {
        writeFileSync(join(state.downloadPath, 'guid-1'), expectedBytes);
        beginOwnedDownload(browserWs, 'foreign-guid', 'unrelated-frame');
        beginOwnedDownload(browserWs, 'guid-1');
        completeOwnedDownload(browserWs, 'guid-1');
      },
    });
    const output = join(tmpRoot, 'capture.jpeg');
    const result = await helpers.downloadAndPublishBatchWithMeta(
      harness.pageWs,
      { ok: true, candidates: [candidate] },
      'verify()',
      output,
      fullSizeIdentity(),
      {
        timeoutMs: 2000,
        fullSizeTimeoutMs: 1000,
        verifyTimeoutMs: 500,
        browserWs: harness.browserWs,
      },
    );
    assert.deepEqual(Array.from(result.files), [join(tmpRoot, 'capture.png')]);
    assert.equal(result.downloadSource, 'full_size_download');
    assert.deepEqual(Array.from(result.fallbackReasons), []);
    assert.deepEqual(readFileSync(join(tmpRoot, 'capture.png')), expectedBytes);
    assert.equal(statSync(join(tmpRoot, 'capture.png')).mode & 0o777, 0o600);
    assert.equal(harness.state.behaviors[0], 'allowAndName');
    assert.equal(harness.state.behaviors.at(-1), 'default');
    assert.equal(existsSync(harness.state.downloadPath), false);
    assert.deepEqual(harness.state.cancels, []);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('full-size download verifies a late OOPIF sandbox iframe with a bounded Target.getTargets and replays blob:null download events', async () => {
  const timerDelays = [];
  const helpers = loadGeminiDownloadHelpers({
    setTimeout(fn, ms) {
      timerDelays.push(ms);
      return setTimeout(fn, ms);
    },
  });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-oopif-'));
  try {
    const candidate = makeFullSizeCandidate(1);
    const expectedBytes = makeSyntheticJpeg(2752, 1536, { zeroFillBeforeSof: true });
    const ownedTargets = [
      { targetId: 'main-frame', type: 'page', url: 'https://gemini.google.com/app', browserContextId: 'ctx-owned' },
      { targetId: 'oopif-frame', type: 'iframe', parentFrameId: 'main-frame', url: 'about:srcdoc', browserContextId: 'ctx-owned' },
    ];
    const harness = makeFullSizeHarness(candidate, {
      onGetTargets({ call }) {
        return { targetInfos: call === 1 ? [] : ownedTargets };
      },
      onClick({ browserWs, state }) {
        writeFileSync(join(state.downloadPath, 'guid-oopif'), expectedBytes);
        beginOwnedDownload(browserWs, 'guid-oopif', 'oopif-frame', 'blob:null/7c7d3dc2-2fa0-41bc-95da-8157cf998131');
        completeOwnedDownload(browserWs, 'guid-oopif');
      },
    });
    const output = join(tmpRoot, 'oopif.jpeg');
    const result = await helpers.downloadAndPublishBatchWithMeta(
      harness.pageWs,
      { ok: true, candidates: [candidate] },
      'verify()',
      output,
      fullSizeIdentity(),
      {
        timeoutMs: 3000,
        fullSizeTimeoutMs: 2000,
        verifyTimeoutMs: 10000,
        eventGraceMs: 1000,
        browserWs: harness.browserWs,
      },
    );
    assert.equal(result.downloadSource, 'full_size_download');
    assert.deepEqual(Array.from(result.files), [join(tmpRoot, 'oopif.jpg')]);
    assert.deepEqual(readFileSync(join(tmpRoot, 'oopif.jpg')), expectedBytes);
    assert.equal(harness.state.targetSetDiscoverCalls, 1);
    assert.ok(harness.state.targetGetCalls >= 2, 'initial discovery plus one unknown-frame verification');
    assert.ok(timerDelays.includes(2000), 'Target.getTargets checks must be capped at 2000ms');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('full-size download drops unverified OOPIF download events after Target.getTargets timeout or no ownership', async () => {
  const candidate = makeFullSizeCandidate(1);
  const ownedPage = { targetId: 'main-frame', type: 'page', url: 'https://gemini.google.com/app', browserContextId: 'ctx-owned' };

  for (const mode of ['timeout', 'no-ownership']) {
    const tmpRoot = mkdtempSync(join(tmpdir(), `gemini-full-oopif-${mode}-`));
    try {
      const helpers = loadGeminiDownloadHelpers();
      const foreignTargets = [
        ownedPage,
        { targetId: 'foreign-frame', type: 'iframe', parentFrameId: 'foreign-page', url: 'about:srcdoc', browserContextId: 'ctx-owned' },
      ];
      const harness = makeFullSizeHarness(candidate, {
        onGetTargets({ call }) {
          if (call === 1) return { targetInfos: [] };
          if (mode === 'timeout') return new Promise(() => {});
          return { targetInfos: foreignTargets };
        },
        onClick({ browserWs, state }) {
          writeFileSync(join(state.downloadPath, 'guid-unverified'), makeSyntheticJpeg(2752, 1536));
          beginOwnedDownload(browserWs, 'guid-unverified', 'foreign-frame', 'blob:null/11111111-2222-3333-4444-555555555555');
          completeOwnedDownload(browserWs, 'guid-unverified');
        },
      });
      const result = await helpers.downloadAndPublishBatchWithMeta(
        harness.pageWs,
        { ok: true, candidates: [candidate] },
        'verify()',
        join(tmpRoot, 'drop.jpeg'),
        fullSizeIdentity(),
        {
          timeoutMs: 600,
          fullSizeTimeoutMs: 400,
          verifyTimeoutMs: mode === 'timeout' ? 60 : 2000,
          eventGraceMs: 120,
          browserWs: harness.browserWs,
        },
      );
      assert.equal(result.downloadSource, 'preview_fallback');
      assert.deepEqual(Array.from(result.fallbackReasons), ['click_no_download_event']);
      assert.deepEqual(Array.from(result.files), [join(tmpRoot, 'drop.png')]);
      assert.equal(existsSync(join(tmpRoot, 'drop.jpg')), false);
      assert.ok(harness.state.targetGetCalls >= 2);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
});

test('full-size download fails closed for multiple owned guids, extra files, unsafe URLs, and oversized downloads', async () => {
  const helpers = loadGeminiDownloadHelpers();
  const candidate = makeFullSizeCandidate(1);
  const identity = fullSizeIdentity();

  {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-guids-'));
    try {
      const harness = makeFullSizeHarness(candidate, {
        onClick({ browserWs, state }) {
          writeFileSync(join(state.downloadPath, 'guid-1'), makeSyntheticPng(2752, 1536));
          writeFileSync(join(state.downloadPath, 'guid-2'), makeSyntheticPng(2752, 1536));
          beginOwnedDownload(browserWs, 'guid-1');
          beginOwnedDownload(browserWs, 'guid-2');
        },
      });
      await assert.rejects(
        () => helpers.downloadAndPublishBatchWithMeta(
          harness.pageWs,
          { ok: true, candidates: [candidate] },
          'verify()',
          join(tmpRoot, 'multi-guid.jpeg'),
          identity,
          { timeoutMs: 1500, fullSizeTimeoutMs: 500, verifyTimeoutMs: 200, browserWs: harness.browserWs },
        ),
        (error) => assertFailClosed(error, /multiple owned downloads/),
      );
      assert.deepEqual(harness.state.cancels.sort(), ['guid-1', 'guid-2']);
      assert.equal(harness.state.behaviors.at(-1), 'default');
      assert.equal(existsSync(join(tmpRoot, 'multi-guid.png')), false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-extra-'));
    try {
      const harness = makeFullSizeHarness(candidate, {
        onClick({ browserWs, state }) {
          writeFileSync(join(state.downloadPath, 'guid-1'), makeSyntheticPng(2752, 1536));
          writeFileSync(join(state.downloadPath, 'unexpected.bin'), 'extra');
          beginOwnedDownload(browserWs, 'guid-1');
          completeOwnedDownload(browserWs, 'guid-1');
        },
      });
      await assert.rejects(
        () => helpers.downloadAndPublishBatchWithMeta(
          harness.pageWs,
          { ok: true, candidates: [candidate] },
          'verify()',
          join(tmpRoot, 'extra-file.jpeg'),
          identity,
          { timeoutMs: 1500, fullSizeTimeoutMs: 500, verifyTimeoutMs: 200, browserWs: harness.browserWs },
        ),
        (error) => assertFailClosed(error, /unexpected temporary files/),
      );
      assert.deepEqual(harness.state.cancels, ['guid-1']);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-evil-url-'));
    try {
      const harness = makeFullSizeHarness(candidate, {
        onClick({ browserWs }) {
          beginOwnedDownload(browserWs, 'guid-1', 'main-frame', 'https://evil.example.com/download');
        },
      });
      await assert.rejects(
        () => helpers.downloadAndPublishBatchWithMeta(
          harness.pageWs,
          { ok: true, candidates: [candidate] },
          'verify()',
          join(tmpRoot, 'evil-url.jpeg'),
          identity,
          { timeoutMs: 1500, fullSizeTimeoutMs: 500, verifyTimeoutMs: 200, browserWs: harness.browserWs },
        ),
        (error) => assertFailClosed(error, /not allowlisted/),
      );
      assert.deepEqual(harness.state.cancels, ['guid-1']);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-oversize-'));
    try {
      const harness = makeFullSizeHarness(candidate, {
        onClick({ browserWs, state }) {
          writeFileSync(join(state.downloadPath, 'guid-1'), makeSyntheticPng(2752, 1536));
          beginOwnedDownload(browserWs, 'guid-1');
          completeOwnedDownload(browserWs, 'guid-1');
        },
      });
      const fsOps = {
        ...require('node:fs'),
        lstatSync(target) {
          if (harness.state.downloadPath && target.startsWith(harness.state.downloadPath)) {
            return { isSymbolicLink: () => false, isFile: () => true, size: helpers.MAX_IMAGE_BYTES + 1 };
          }
          return require('node:fs').lstatSync(target);
        },
      };
      await assert.rejects(
        () => helpers.downloadAndPublishBatchWithMeta(
          harness.pageWs,
          { ok: true, candidates: [candidate] },
          'verify()',
          join(tmpRoot, 'oversize.jpeg'),
          identity,
          { timeoutMs: 1500, fullSizeTimeoutMs: 500, verifyTimeoutMs: 200, browserWs: harness.browserWs, fsOps },
        ),
        (error) => assertFailClosed(error, /exceeded maximum allowed bytes/),
      );
      assert.equal(existsSync(join(tmpRoot, 'oversize.png')), false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
});

test('full-size download fails closed for a non-loopback browser websocket', async () => {
  const helpers = loadGeminiDownloadHelpers();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-loopback-'));
  try {
    const candidate = makeFullSizeCandidate(1);
    const ws = makeVerifySocket([candidate]);
    await assert.rejects(
      () => helpers.downloadAndPublishBatchWithMeta(
        ws,
        { ok: true, candidates: [candidate] },
        'verify()',
        join(tmpRoot, 'loopback.jpeg'),
        fullSizeIdentity(),
        {
          timeoutMs: 500,
          fullSizeTimeoutMs: 300,
          verifyTimeoutMs: 200,
          fetch: async () => ({
            json: async () => ({
              webSocketDebuggerUrl: 'ws://evil.example.com:9223/devtools/browser/browser-1',
            }),
          }),
          WebSocketCtor: function ForbiddenWebSocket() {
            throw new Error('non-loopback websocket must never be opened');
          },
        },
      ),
      (error) => assertFailClosed(error, /loopback/),
    );
    assert.equal(existsSync(join(tmpRoot, 'loopback.png')), false);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('full-size download fails closed for symlinks and truncated image trailers without preview fallback', async () => {
  const helpers = loadGeminiDownloadHelpers();
  const candidate = makeFullSizeCandidate(1);
  const identity = fullSizeIdentity();

  {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-symlink-'));
    try {
      const outside = join(tmpRoot, 'outside.bin');
      writeFileSync(outside, makeSyntheticPng(2752, 1536));
      const harness = makeFullSizeHarness(candidate, {
        onClick({ browserWs, state }) {
          symlinkSync(outside, join(state.downloadPath, 'guid-1'));
          beginOwnedDownload(browserWs, 'guid-1');
          completeOwnedDownload(browserWs, 'guid-1');
        },
      });
      await assert.rejects(
        () => helpers.downloadAndPublishBatchWithMeta(
          harness.pageWs,
          { ok: true, candidates: [candidate] },
          'verify()',
          join(tmpRoot, 'symlink.jpeg'),
          identity,
          { timeoutMs: 1500, fullSizeTimeoutMs: 500, verifyTimeoutMs: 200, browserWs: harness.browserWs },
        ),
        (error) => assertFailClosed(error, /not a regular file/),
      );
      assert.equal(existsSync(join(tmpRoot, 'symlink.png')), false);
      assert.deepEqual(readFileSync(outside), makeSyntheticPng(2752, 1536));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  for (const label of ['truncated-png', 'missing-eoi-jpeg']) {
    const tmpRoot = mkdtempSync(join(tmpdir(), `gemini-full-${label}-`));
    try {
      const bytes = label === 'truncated-png'
        ? makeSyntheticPng(2752, 1536, { truncateIend: true })
        : makeSyntheticJpeg(2752, 1536, { missingEoi: true });
      const harness = makeFullSizeHarness(candidate, {
        onClick({ browserWs, state }) {
          writeFileSync(join(state.downloadPath, 'guid-1'), bytes);
          beginOwnedDownload(browserWs, 'guid-1');
          completeOwnedDownload(browserWs, 'guid-1');
        },
      });
      await assert.rejects(
        () => helpers.downloadAndPublishBatchWithMeta(
          harness.pageWs,
          { ok: true, candidates: [candidate] },
          'verify()',
          join(tmpRoot, `${label}.jpeg`),
          identity,
          { timeoutMs: 1500, fullSizeTimeoutMs: 500, verifyTimeoutMs: 200, browserWs: harness.browserWs },
        ),
        (error) => assertFailClosed(error, /header\/trailer validation/),
      );
      assert.equal(existsSync(join(tmpRoot, `${label}.png`)), false);
      assert.equal(existsSync(join(tmpRoot, `${label}.jpg`)), false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
});

test('full-size download fails closed with exitCode 2 when turn identity changes before click or before preview fallback', async () => {
  const helpers = loadGeminiDownloadHelpers();
  const candidate = makeFullSizeCandidate(1);
  const identity = fullSizeIdentity();

  {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-identity-click-'));
    try {
      const harness = makeFullSizeHarness(candidate, {
        clickResult: { ok: false, reason: 'turn_id_mismatch', identityChanged: true },
      });
      await assert.rejects(
        () => helpers.downloadAndPublishBatchWithMeta(
          harness.pageWs,
          { ok: true, candidates: [candidate] },
          'verify()',
          join(tmpRoot, 'identity-click.jpeg'),
          identity,
          { timeoutMs: 1500, fullSizeTimeoutMs: 500, verifyTimeoutMs: 200, browserWs: harness.browserWs },
        ),
        (error) => assertFailClosed(error, /identity changed/, 2),
      );
      assert.equal(existsSync(join(tmpRoot, 'identity-click.png')), false);
      assert.equal(harness.state.behaviors.at(-1), 'default');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-identity-fallback-'));
    try {
      const ws = makeCdpSocket((message) => {
        if (message.method !== 'Runtime.evaluate') return {};
        return { result: { value: { ok: false, reason: 'candidates_mismatch' } } };
      });
      const fullSizeFn = async () => { throw makeFallbackError('button_not_found'); };
      await assert.rejects(
        () => helpers.downloadAndPublishBatchWithMeta(
          ws,
          { ok: true, candidates: [candidate] },
          'verify()',
          join(tmpRoot, 'identity-fallback.jpeg'),
          identity,
          {
            timeoutMs: 1500,
            fullSizeTimeoutMs: 500,
            verifyTimeoutMs: 200,
            browserWs: {},
            downloadFullSizeCandidateViaBrowser: fullSizeFn,
          },
        ),
        (error) => assertFailClosed(error, /identity changed/, 2),
      );
      assert.equal(existsSync(join(tmpRoot, 'identity-fallback.png')), false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
});

test('full-size button_not_found falls back to exactly one verified preview per candidate and dedupes fallback reasons', async () => {
  const helpers = loadGeminiDownloadHelpers();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-button-missing-'));
  try {
    const first = makeFullSizeCandidate(1);
    const second = makeFullSizeCandidate(2);
    const candidates = [first, second];
    const harness = makeFullSizeHarness(first, {
      verifyResult: { ok: true, candidates },
      clickResult: { ok: false, reason: 'button_not_found', identityChanged: false },
    });
    const outputDir = join(tmpRoot, 'out');
    const result = await helpers.downloadAndPublishBatchWithMeta(
      harness.pageWs,
      { ok: true, candidates },
      'verify()',
      outputDir,
      fullSizeIdentity(),
      { timeoutMs: 2000, fullSizeTimeoutMs: 500, verifyTimeoutMs: 300, browserWs: harness.browserWs },
    );
    assert.equal(result.downloadSource, 'preview_fallback');
    assert.deepEqual(Array.from(result.fallbackReasons), ['button_not_found']);
    assert.equal(result.files.length, 2);
    assert.equal(new Set(result.files).size, 2);
    assert.ok(result.files.every((file) => file.endsWith('.png')));
    assert.deepEqual(readdirSync(outputDir).length, 2);
    for (const reason of result.fallbackReasons) {
      assert.ok(helpers.FULL_SIZE_FALLBACK_REASONS.has(reason));
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('any full-size preview fallback marks the whole batch preview_fallback while keeping one file per candidate', async () => {
  const helpers = loadGeminiDownloadHelpers();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-mixed-'));
  try {
    const first = makeFullSizeCandidate(1);
    const second = makeFullSizeCandidate(2);
    const candidates = [first, second];
    let attempt = 0;
    const harness = makeFullSizeHarness(first, {
      verifyResult: { ok: true, candidates },
      clickResult: () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, reason: 'button_not_found', identityChanged: false }
          : { ok: true };
      },
      onClick({ browserWs, state }) {
        if (attempt === 1) return;
        writeFileSync(join(state.downloadPath, 'guid-2'), makeSyntheticPng(2752, 1536));
        beginOwnedDownload(browserWs, 'guid-2');
        completeOwnedDownload(browserWs, 'guid-2');
      },
    });
    const outputDir = join(tmpRoot, 'out');
    const result = await helpers.downloadAndPublishBatchWithMeta(
      harness.pageWs,
      { ok: true, candidates },
      'verify()',
      outputDir,
      fullSizeIdentity(),
      { timeoutMs: 2000, fullSizeTimeoutMs: 500, verifyTimeoutMs: 300, browserWs: harness.browserWs },
    );
    assert.equal(result.downloadSource, 'preview_fallback');
    assert.deepEqual(Array.from(result.fallbackReasons), ['button_not_found']);
    assert.equal(result.files.length, 2);
    assert.equal(new Set(result.files).size, 2);
    assert.deepEqual(readdirSync(outputDir).length, 2);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('click without download event, download timeout, cancellation, missing CDP behavior, and recoverable integrity failure fall back within budget', async () => {
  const helpers = loadGeminiDownloadHelpers();
  const candidate = makeFullSizeCandidate(1);

  const runBatch = async (label, harness, overrides = {}) => {
    const tmpRoot = mkdtempSync(join(tmpdir(), `gemini-full-${label}-`));
    try {
      const startedAt = Date.now();
      const result = await helpers.downloadAndPublishBatchWithMeta(
        harness.pageWs,
        { ok: true, candidates: [candidate] },
        'verify()',
        join(tmpRoot, `${label}.jpeg`),
        fullSizeIdentity(),
        {
          timeoutMs: 700,
          fullSizeTimeoutMs: 250,
          verifyTimeoutMs: 200,
          browserWs: harness.browserWs,
          ...overrides,
        },
      );
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 1200, `${label} fallback must complete well below the watchdog budget`);
      assert.equal(result.downloadSource, 'preview_fallback');
      assert.equal(result.files.length, 1);
      assert.ok(existsSync(result.files[0]));
      return { result, elapsed };
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  };

  {
    const harness = makeFullSizeHarness(candidate, {});
    const { result } = await runBatch('click-no-event', harness);
    assert.deepEqual(Array.from(result.fallbackReasons), ['click_no_download_event']);
  }

  {
    const harness = makeFullSizeHarness(candidate, {
      onClick({ browserWs }) {
        beginOwnedDownload(browserWs, 'guid-1');
      },
    });
    const { result } = await runBatch('download-timeout', harness);
    assert.deepEqual(Array.from(result.fallbackReasons), ['download_timeout']);
  }

  {
    const harness = makeFullSizeHarness(candidate, {
      onClick({ browserWs }) {
        beginOwnedDownload(browserWs, 'guid-1');
        emitDownloadEvent(browserWs, 'Browser.downloadProgress', {
          guid: 'guid-1',
          state: 'canceled',
          receivedBytes: 1,
          totalBytes: 100,
        });
      },
    });
    const { result } = await runBatch('download-canceled', harness);
    assert.deepEqual(Array.from(result.fallbackReasons), ['download_canceled']);
  }

  {
    const harness = makeFullSizeHarness(candidate, {
      onClick({ browserWs }) {
        beginOwnedDownload(browserWs, 'guid-1');
        compileOwnedDownloadCompletion(browserWs, 'guid-1');
      },
    });
    const { result } = await runBatch('integrity-failed', harness, { fullSizeTimeoutMs: 180 });
    assert.deepEqual(Array.from(result.fallbackReasons), ['full_size_integrity_failed']);
  }

  {
    let evalCount = 0;
    let evalsAtConnectFailure = null;
    const ws = makeCdpSocket((message) => {
      if (message.method !== 'Runtime.evaluate') return {};
      evalCount += 1;
      return { result: { value: { ok: true, candidates: [candidate] } } };
    });
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-cdp-unsupported-'));
    try {
      const result = await helpers.downloadAndPublishBatchWithMeta(
        ws,
        { ok: true, candidates: [candidate] },
        'verify()',
        join(tmpRoot, 'cdp-unsupported.jpeg'),
        fullSizeIdentity(),
        {
          timeoutMs: 1000,
          fullSizeTimeoutMs: 500,
          verifyTimeoutMs: 200,
          connectBrowserCdp: async () => {
            evalsAtConnectFailure = evalCount;
            throw makeFallbackError('cdp_download_behavior_unsupported');
          },
        },
      );
      assert.equal(evalsAtConnectFailure, 0);
      assert.ok(evalCount >= 2, 'fallback must re-verify the turn before preview publishing');
      assert.equal(result.downloadSource, 'preview_fallback');
      assert.deepEqual(Array.from(result.fallbackReasons), ['cdp_download_behavior_unsupported']);
      assert.equal(result.files.length, 1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
});

function compileOwnedDownloadCompletion(browserWs, guid) {
  emitDownloadEvent(browserWs, 'Browser.downloadProgress', {
    guid,
    state: 'completed',
    receivedBytes: 100,
    totalBytes: 100,
  });
}

test('downloadAndPublishBatch keeps its array return while timeout overrides follow the locked formula', async () => {
  const helpers = loadGeminiDownloadHelpers();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-formula-'));
  try {
    assert.equal(helpers.DEFAULT_FULL_SIZE_DOWNLOAD_TIMEOUT_MS, 20000);
    const candidate = makeFullSizeCandidate(1);
    const ws = makeVerifySocket([candidate]);

    const legacyOutput = join(tmpRoot, 'legacy.png');
    const legacy = await helpers.downloadAndPublishBatch(
      ws,
      { ok: true, candidates: [candidate] },
      'verify()',
      legacyOutput,
      { timeoutMs: 1000 },
    );
    assert.ok(Array.isArray(legacy));
    assert.deepEqual(Array.from(legacy), [legacyOutput]);
    assert.ok(existsSync(legacyOutput));

    const capturedTimeouts = [];
    const fakeFullSize = async (_ws, _browserWs, _before, _candidate, _identity, options) => {
      capturedTimeouts.push(options.timeoutMs);
      return { buffer: makeSyntheticPng(2752, 1536), ext: 'png' };
    };
    for (const [perImageTimeoutMs, configuredFullSizeTimeoutMs, expectedTimeoutMs] of [
      [300, 20000, 200],
      [300, 50, 50],
      [2, 20000, 1],
    ]) {
      capturedTimeouts.length = 0;
      const result = await helpers.downloadAndPublishBatchWithMeta(
        ws,
        { ok: true, candidates: [candidate] },
        'verify()',
        join(tmpRoot, `formula-${perImageTimeoutMs}-${configuredFullSizeTimeoutMs}.png`),
        fullSizeIdentity(),
        {
          timeoutMs: perImageTimeoutMs,
          fullSizeTimeoutMs: configuredFullSizeTimeoutMs,
          verifyTimeoutMs: 50,
          browserWs: {},
          downloadFullSizeCandidateViaBrowser: fakeFullSize,
        },
      );
      assert.equal(capturedTimeouts[0], expectedTimeoutMs);
      assert.equal(result.downloadSource, 'full_size_download');
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runCli reports full_size_download without fallback_reasons and preserves the output extension contract', async () => {
  const helpers = loadGeminiDownloadHelpers();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-cli-success-'));
  try {
    const candidate = makeFullSizeCandidate(1);
    const expectedBytes = makeSyntheticPng(2752, 1536);
    const harness = makeRunCliHarness([candidate], {
      onClick({ browserWs, state }) {
        writeFileSync(join(state.downloadPath, 'guid-1'), expectedBytes);
        beginOwnedDownload(browserWs, 'guid-1');
        completeOwnedDownload(browserWs, 'guid-1');
      },
    });
    const stdout = [];
    let watchdogFired = false;
    const output = join(tmpRoot, 'cli.jpeg');
    await helpers.runCli({
      tokenArg: 'token-1',
      outputArg: output,
      expectedIdentityJsonArg: JSON.stringify(fullSizeIdentity()),
      fetch: makeRunCliFetch(helpers.GEMINI_ORIGIN),
      WebSocketCtor: function FakeWebSocket() { return harness.pageWs; },
      browserWs: harness.browserWs,
      timeoutMs: 1000,
      fullSizeTimeoutMs: 500,
      verifyTimeoutMs: 200,
      cleanupTimeoutMs: 40,
      overallLimitMs: 3000,
      onWatchdogExit: () => { watchdogFired = true; },
      writeStdout: (value) => { stdout.push(value); },
    });
    assert.equal(watchdogFired, false);
    assert.equal(stdout.length, 1);
    const payload = JSON.parse(stdout[0]);
    assert.deepEqual(Object.keys(payload).sort(), ['count', 'download_source', 'files', 'ok']);
    assert.equal(payload.ok, true);
    assert.equal(payload.count, 1);
    assert.deepEqual(payload.files, [join(tmpRoot, 'cli.png')]);
    assert.equal(payload.download_source, 'full_size_download');
    assert.equal(harness.state.behaviors.at(-1), 'default');
    assert.equal(existsSync(harness.state.downloadPath), false);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runCli completes a preview fallback inside the watchdog budget and reports fallback_reasons', async () => {
  const helpers = loadGeminiDownloadHelpers();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-cli-timeout-'));
  try {
    const candidate = makeFullSizeCandidate(1);
    const harness = makeRunCliHarness([candidate], {
      onClick({ browserWs }) {
        beginOwnedDownload(browserWs, 'guid-1');
      },
    });
    const stdout = [];
    let watchdogFired = false;
    const startedAt = Date.now();
    await helpers.runCli({
      tokenArg: 'token-1',
      outputArg: join(tmpRoot, 'cli-timeout.jpeg'),
      expectedIdentityJsonArg: JSON.stringify(fullSizeIdentity()),
      fetch: makeRunCliFetch(helpers.GEMINI_ORIGIN),
      WebSocketCtor: function FakeWebSocket() { return harness.pageWs; },
      browserWs: harness.browserWs,
      timeoutMs: 300,
      fullSizeTimeoutMs: 150,
      verifyTimeoutMs: 200,
      cleanupTimeoutMs: 40,
      overallLimitMs: 1500,
      onWatchdogExit: () => { watchdogFired = true; },
      writeStdout: (value) => { stdout.push(value); },
    });
    assert.ok(Date.now() - startedAt < 1400, 'preview fallback must finish before the watchdog');
    assert.equal(watchdogFired, false);
    const payload = JSON.parse(stdout[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.count, 1);
    assert.equal(payload.download_source, 'preview_fallback');
    assert.deepEqual(payload.fallback_reasons, ['download_timeout']);
    assert.deepEqual(payload.files, [join(tmpRoot, 'cli-timeout.png')]);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runCli returns the fail-closed exitCode 2 and publishes nothing when the turn changes before click', async () => {
  const helpers = loadGeminiDownloadHelpers();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-cli-identity-'));
  try {
    const candidate = makeFullSizeCandidate(1);
    const harness = makeRunCliHarness([candidate], {
      clickResult: { ok: false, reason: 'turn_id_mismatch', identityChanged: true },
    });
    const stdout = [];
    let failure = null;
    try {
      await helpers.runCli({
        tokenArg: 'token-1',
        outputArg: join(tmpRoot, 'cli-identity.jpeg'),
        expectedIdentityJsonArg: JSON.stringify(fullSizeIdentity()),
        fetch: makeRunCliFetch(helpers.GEMINI_ORIGIN),
        WebSocketCtor: function FakeWebSocket() { return harness.pageWs; },
        browserWs: harness.browserWs,
        timeoutMs: 1000,
        fullSizeTimeoutMs: 500,
        verifyTimeoutMs: 200,
        cleanupTimeoutMs: 40,
        overallLimitMs: 2000,
        onWatchdogExit: () => {},
        writeStdout: (value) => { stdout.push(value); },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'runCli must reject on identity change');
    assert.equal(failure.exitCode, 2);
    assert.equal(failure.fallbackEligible, false);
    assert.match(failure.message, /identity changed/);
    assert.deepEqual(stdout, []);
    assert.equal(existsSync(join(tmpRoot, 'cli-identity.png')), false);
    assert.equal(harness.state.behaviors.at(-1), 'default');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runCli watchdog uses the locked formula and honors the overallLimitMs override', async () => {
  const candidate = makeFullSizeCandidate(1);
  const fakeFullSize = async () => ({ buffer: makeSyntheticPng(2752, 1536), ext: 'png' });

  const runOnce = async (overrides) => {
    const timers = makeFakeTimerHarness();
    const helpers = loadGeminiDownloadHelpers({
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gemini-full-watchdog-'));
    try {
      const stdout = [];
      await helpers.runCli({
        tokenArg: 'token-1',
        outputArg: join(tmpRoot, 'watchdog.png'),
        expectedIdentityJsonArg: JSON.stringify(fullSizeIdentity()),
        fetch: makeRunCliFetch(helpers.GEMINI_ORIGIN),
        WebSocketCtor: function FakeWebSocket() { return makeVerifySocket([candidate]); },
        browserWs: {},
        downloadFullSizeCandidateViaBrowser: fakeFullSize,
        cleanupTimeoutMs: 40,
        onWatchdogExit: () => {},
        writeStdout: (value) => { stdout.push(value); },
        ...overrides,
      });
      assert.equal(JSON.parse(stdout[0]).ok, true);
      return timers.delays.slice();
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  };

  const formulaDelays = await runOnce({ timeoutMs: 40000, fullSizeTimeoutMs: 20000, verifyTimeoutMs: 500 });
  assert.ok(formulaDelays.includes(45000), 'initial watchdog must remain 45000ms');
  assert.ok(formulaDelays.includes(55500), 'candidate-aware watchdog must be 40000 + 500 + 15000');

  const overrideDelays = await runOnce({ timeoutMs: 1000, fullSizeTimeoutMs: 500, verifyTimeoutMs: 200, overallLimitMs: 1234 });
  assert.ok(overrideDelays.includes(1234), 'overallLimitMs must override the watchdog');
  assert.equal(overrideDelays.includes(55500), false);
});
