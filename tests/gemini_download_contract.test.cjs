const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const repoRoot = join(__dirname, '..');

const loadGeminiDownloadHelpers = () => {
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
    setTimeout,
    clearTimeout,
    fetch,
  };
  vm.runInNewContext(source, context, { filename: 'gemini_download.js' });
  return context.module.exports;
};

const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

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
        cleanupTimeoutMs: 40,
        overallLimitMs: 1500,
        onWatchdogExit: () => { watchdogFired = true; },
        writeStdout: (value) => stdout.push(value),
      }),
      /timed out/,
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
      /timed out/,
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
