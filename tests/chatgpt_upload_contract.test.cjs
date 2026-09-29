const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { join } = require('node:path');
const vm = require('node:vm');

const repoRoot = join(__dirname, '..');

// Load the CDP upload helper without running it, and return its internals for
// contract tests.  The module is executed by `node -e` in production, so the
// autorun guard is what keeps this test honest to the shipped source.
const loadUploadHelpers = () => {
  const source = readFileSync(join(repoRoot, 'src', 'chatgpt_upload.js'), 'utf8');
  const context = {
    console,
    module: { exports: {} },
    exports: {},
    process: {
      argv: ['node', 'token', '/tmp/example.md', 'document'],
      env: { ASK_BRIDGE_UPLOAD_NO_AUTORUN: '1' },
      exit: () => {},
    },
    require,
    setTimeout,
    clearTimeout,
    fetch: () => {
      throw new Error('fetch is not available in the contract test');
    },
    WebSocket: class {
      constructor() {
        throw new Error('WebSocket is not available in the contract test');
      }
    },
  };
  vm.runInNewContext(source, context, { filename: 'chatgpt_upload.js' });
  return context.module.exports;
};

const makeFakeCdp = (handlers) => {
  const calls = [];
  return {
    calls,
    call: async (method, params = {}) => {
      calls.push({ method, params });
      return handlers(method, params, calls);
    },
  };
};

const isMenuCheck = (params) => params.expression.includes('some(label');
const isMenuClick = (params) => params.expression.includes('pointerdown');

test('the composer file input is used directly without touching the attachment menu', async () => {
  const helpers = loadUploadHelpers();
  const cdp = makeFakeCdp((method) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 121 };
    throw new Error(`unexpected CDP call ${method}`);
  });
  const nodeId = await helpers.resolveFileInputNodeId(cdp, 'document');
  assert.equal(nodeId, 121);
  assert.deepEqual(
    cdp.calls.map((entry) => entry.method),
    ['DOM.getDocument', 'DOM.querySelector'],
  );
});

test('document and image selectors stay pinned to the ChatGPT labels', () => {
  const helpers = loadUploadHelpers();
  assert.match(helpers.FILE_INPUT_SELECTOR.document, /附加檔案/);
  assert.match(helpers.FILE_INPUT_SELECTOR.image, /附加相片或影片/);
});

test('a missing input falls back to opening the menu and re-queries the input', async () => {
  const helpers = loadUploadHelpers();
  let queries = 0;
  let menuOpen = false;
  let clicks = 0;
  const cdp = makeFakeCdp((method, params) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') {
      queries += 1;
      return queries === 1 ? { nodeId: 0 } : { nodeId: 7 };
    }
    if (method === 'Runtime.evaluate' && isMenuCheck(params)) return { result: { value: menuOpen } };
    if (method === 'Runtime.evaluate' && isMenuClick(params)) {
      clicks += 1;
      menuOpen = true;
      return { result: { value: true } };
    }
    throw new Error(`unexpected CDP call ${method}`);
  });
  const nodeId = await helpers.resolveFileInputNodeId(cdp, 'document', {
    maxClicks: 2,
    attempts: 2,
    pollMs: 1,
  });
  assert.equal(nodeId, 7);
  assert.equal(clicks, 1);
  assert.equal(queries, 2);
});

test('a phantom-open menu trigger is retried until the click budget is spent', async () => {
  const helpers = loadUploadHelpers();
  let clicks = 0;
  const cdp = makeFakeCdp((method, params) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 0 };
    if (method === 'Runtime.evaluate' && isMenuCheck(params)) return { result: { value: false } };
    if (method === 'Runtime.evaluate' && isMenuClick(params)) {
      clicks += 1;
      return { result: { value: true } };
    }
    throw new Error(`unexpected CDP call ${method}`);
  });
  await assert.rejects(
    helpers.ensureMenuOpen(cdp, { maxClicks: 3, attempts: 1, pollMs: 1 }),
    /Attachment menu did not open/,
  );
  assert.equal(clicks, 3);
});

test('an input that never mounts reports File input unavailable', async () => {
  const helpers = loadUploadHelpers();
  let menuOpen = false;
  const cdp = makeFakeCdp((method, params) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 0 };
    if (method === 'Runtime.evaluate' && isMenuCheck(params)) return { result: { value: menuOpen } };
    if (method === 'Runtime.evaluate' && isMenuClick(params)) {
      menuOpen = true;
      return { result: { value: true } };
    }
    throw new Error(`unexpected CDP call ${method}`);
  });
  await assert.rejects(
    helpers.resolveFileInputNodeId(cdp, 'document', { maxClicks: 1, attempts: 1, pollMs: 1 }),
    /File input unavailable/,
  );
});
