const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { join } = require('node:path');
const vm = require('node:vm');

const repoRoot = join(__dirname, '..');

const loadGeminiUploadHelpers = () => {
  const source = readFileSync(join(repoRoot, 'src', 'gemini_upload.js'), 'utf8');
  const context = {
    console,
    module: { exports: {} },
    exports: {},
    process: {
      argv: ['node', 'token', '/tmp/example.png', 'image'],
      env: { ASK_BRIDGE_UPLOAD_NO_AUTORUN: '1' },
      exit: () => {},
    },
    require,
    URL,
    setTimeout,
    clearTimeout,
    fetch: () => {
      throw new Error('fetch is not available in unit test');
    },
    WebSocket: class {
      constructor() {
        throw new Error('WebSocket is not available in unit test');
      }
    },
  };
  vm.runInNewContext(source, context, { filename: 'gemini_upload.js' });
  return context.module.exports;
};

const makeFakeCdp = (handlers) => {
  const calls = [];
  const listeners = new Map();
  return {
    calls,
    emit(eventName, params) {
      const fn = listeners.get(eventName);
      if (fn) {
        listeners.delete(eventName);
        fn(params);
      }
    },
    call: async (method, params = {}) => {
      calls.push({ method, params });
      return handlers(method, params, calls);
    },
    onceEvent: (eventName) => new Promise((resolve) => {
      listeners.set(eventName, resolve);
    }),
  };
};

const makeAriaStepHarness = ({ ariaControls, ariaOwns }) => {
  const calls = [];
  const listeners = new Map();
  let cdp;
  const menuIds = Array.from(new Set(
    [ariaControls, ariaOwns]
      .filter(Boolean)
      .flatMap((raw) => String(raw).trim().split(/\s+/).filter(Boolean)),
  ));
  const document = {
    body: { tagName: 'BODY' },
    documentElement: { tagName: 'HTML' },
    querySelectorAll: (selector) => (
      selector === '[role="menu"], [role="listbox"], .mat-mdc-menu-panel, .cdk-overlay-pane'
        ? menus
        : []
    ),
    getElementById: (id) => menus.find((menu) => menu.id === id) || null,
  };
  const window = {
    location: { origin: 'https://gemini.google.com' },
    document,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  };
  function HTMLInputElement() {}
  HTMLInputElement.prototype.click = () => {};
  const input = Object.create(HTMLInputElement.prototype);
  Object.assign(input, {
    ownerDocument: document,
    tagName: 'INPUT',
    type: 'file',
  });
  const uploadItem = {
    textContent: 'Upload files',
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 160, height: 40 }),
    click: () => input.click(),
  };
  const menus = menuIds.map((id) => ({
    id,
    ownerDocument: document,
    matches: () => true,
    querySelector: () => null,
    querySelectorAll: () => [uploadItem],
    getBoundingClientRect: () => ({ width: 200, height: 120 }),
    contains: (node) => node === input,
  }));
  input.parentNode = menus[0];
  const uploadBtn = {
    tagName: 'BUTTON',
    textContent: 'Add files',
    getAttribute(name) {
      if (name === 'aria-controls') return ariaControls;
      if (name === 'aria-owns') return ariaOwns;
      if (name === 'aria-label') return 'Add files';
      return null;
    },
    getBoundingClientRect: () => ({ width: 40, height: 40 }),
    click: () => {},
  };
  const composer = {
    querySelectorAll: () => [uploadBtn],
    contains: (node) => node === input,
  };
  const context = {
    window,
    document,
    composer,
    input,
    HTMLInputElement,
  };
  cdp = {
    calls,
    emit(eventName, params) {
      const fn = listeners.get(eventName);
      if (fn) {
        listeners.delete(eventName);
        fn(params);
      }
    },
    call: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'Page.enable' || method === 'DOM.enable') return {};
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame-1' } } };
      if (method === 'Runtime.evaluate' && params.returnByValue === false) {
        return { result: { objectId: 'composer-obj-1' } };
      }
      if (
        method === 'Runtime.evaluate'
        && String(params.expression).includes('delete window.__ask_bridge_upload_token')
      ) {
        vm.runInNewContext(params.expression, context);
        return {};
      }
      if (
        method === 'Runtime.evaluate'
        && String(params.expression).includes('__ask_bridge_pre_menus_v1')
      ) {
        const value = vm.runInNewContext(params.expression, context);
        if (value && value.clicked === true) {
          cdp.emit('Page.fileChooserOpened', {
            frameId: 'main-frame-1',
            backendNodeId: 777,
          });
        }
        return { result: { value } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      if (method === 'DOM.describeNode' && params.objectId === 'composer-obj-1') {
        return { node: { nodeType: 1, nodeName: 'RICH-TEXTAREA', children: [] } };
      }
      if (method === 'DOM.describeNode' && params.backendNodeId === 777) {
        return {
          node: {
            nodeType: 1,
            nodeName: 'INPUT',
            attributes: ['type', 'file', 'accept', 'image/*'],
          },
        };
      }
      if (method === 'DOM.resolveNode' && params.backendNodeId === 777) {
        return { object: { objectId: 'input-obj-777' } };
      }
      if (
        method === 'Runtime.callFunctionOn'
        && String(params.functionDeclaration).includes('__ask_bridge_pre_menus_v1')
      ) {
        const value = vm.runInNewContext(
          `(${params.functionDeclaration}).call(composer)`,
          context,
        );
        return { result: { value } };
      }
      if (
        method === 'Runtime.callFunctionOn'
        && String(params.functionDeclaration).includes('isShadowWithin')
      ) {
        const value = vm.runInNewContext(
          `(${params.functionDeclaration}).call(composer, input)`,
          context,
        );
        return { result: { value } };
      }
      if (method === 'Page.setInterceptFileChooserDialog') return {};
      if (method === 'DOM.setFileInputFiles') return {};
      throw new Error(`unexpected CDP call ${method}`);
    },
    onceEvent: (eventName) => new Promise((resolve) => {
      listeners.set(eventName, resolve);
    }),
  };
  return {
    context,
    cdp,
    uploadBtn,
  };
};

test('isGeminiPageTarget strictly requires type=page and https://gemini.google.com origin', () => {
  const helpers = loadGeminiUploadHelpers();
  assert.equal(helpers.isGeminiPageTarget({ type: 'page', url: 'https://gemini.google.com/app' }), true);
  assert.equal(helpers.isGeminiPageTarget({ type: 'page', url: 'https://gemini.google.com/app/abc123' }), true);
  assert.equal(helpers.isGeminiPageTarget({ type: 'iframe', url: 'https://gemini.google.com/app' }), false);
  assert.equal(helpers.isGeminiPageTarget({ type: 'page', url: 'https://chatgpt.com/' }), false);
  assert.equal(helpers.isGeminiPageTarget({ type: 'page', url: 'https://evil.gemini.google.com/app' }), false);
  assert.equal(helpers.isGeminiPageTarget({ type: 'page', url: 'http://gemini.google.com/app' }), false);
});

test('selectUniqueMatchedTarget rejects 0 or >1 matched targets without writing', async () => {
  const helpers = loadGeminiUploadHelpers();
  const pages = [
    { id: '1', type: 'page', url: 'https://gemini.google.com/app' },
    { id: '2', type: 'page', url: 'https://gemini.google.com/app/xyz' },
  ];
  await assert.rejects(
    helpers.selectUniqueMatchedTarget(pages, async () => false),
    /Owned Gemini page was not unique/,
  );
  await assert.rejects(
    helpers.selectUniqueMatchedTarget(pages, async () => true),
    /Owned Gemini page was not unique/,
  );
  const chosen = await helpers.selectUniqueMatchedTarget(pages, async (p) => p.id === '2');
  assert.equal(chosen.id, '2');
});

test('persistent input inside composer subtree and Shadow DOM is discovered and injected directly', async () => {
  const helpers = loadGeminiUploadHelpers();
  const cdp = makeFakeCdp((method, params) => {
    if (method === 'Page.enable' || method === 'DOM.enable') return {};
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame-1' } } };
    if (method === 'Runtime.evaluate') {
      if (params && params.returnByValue === false) {
        return { result: { objectId: 'composer-obj-1' } };
      }
      return { result: { value: { ok: true } } };
    }
    if (method === 'DOM.describeNode' && params && params.objectId === 'composer-obj-1') {
      return {
        node: {
          nodeType: 1,
          nodeName: 'INPUT-AREA-V2',
          shadowRoots: [
            {
              nodeType: 11,
              children: [
                {
                  nodeType: 1,
                  nodeName: 'INPUT',
                  attributes: ['type', 'file', 'accept', 'image/*'],
                  backendNodeId: 777,
                },
              ],
            },
          ],
        },
      };
    }
    if (method === 'DOM.resolveNode' && params && params.backendNodeId === 777) {
      return { object: { objectId: 'input-obj-777' } };
    }
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
    if (method === 'DOM.setFileInputFiles') return {};
    throw new Error(`unexpected CDP call ${method}`);
  });

  const res = await helpers.uploadToGeminiPage(cdp, '/tmp/s01.png', 'image');
  assert.equal(res.mechanism, 'persistent_input');
  const setCall = cdp.calls.find((c) => c.method === 'DOM.setFileInputFiles');
  assert.deepEqual(JSON.parse(JSON.stringify(setCall.params)), {
    backendNodeId: 777,
    files: ['/tmp/s01.png'],
  });
});

test('ambiguous persistent file inputs fail closed instead of guessing', async () => {
  const helpers = loadGeminiUploadHelpers();
  const cdp = makeFakeCdp((method, params) => {
    if (method === 'Page.enable' || method === 'DOM.enable') return {};
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame-1' } } };
    if (method === 'Runtime.evaluate') {
      if (params && params.returnByValue === false) {
        return { result: { objectId: 'composer-obj-1' } };
      }
      return { result: { value: { ok: true } } };
    }
    if (method === 'DOM.describeNode' && params && params.objectId === 'composer-obj-1') {
      return {
        node: {
          nodeType: 1,
          nodeName: 'FORM',
          children: [
            { nodeType: 1, nodeName: 'INPUT', attributes: ['type', 'file'], backendNodeId: 10 },
            { nodeType: 1, nodeName: 'INPUT', attributes: ['type', 'file'], backendNodeId: 11 },
          ],
        },
      };
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: `input-obj-${params.backendNodeId}` } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
    throw new Error(`unexpected CDP call ${method}`);
  });

  await assert.rejects(
    helpers.uploadToGeminiPage(cdp, '/tmp/s01.png', 'image'),
    /Ambiguous file input elements/,
  );
  assert.equal(cdp.calls.some((c) => c.method === 'DOM.setFileInputFiles'), false);
});

test('dynamic file chooser validates frameId/node/accept/scope and cleans up in finally on failure', async () => {
  const helpers = loadGeminiUploadHelpers();
  const cdp = makeFakeCdp((method, params) => {
    if (method === 'Page.enable' || method === 'DOM.enable') return {};
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame-1' } } };
    if (method === 'Runtime.evaluate') {
      if (params && params.returnByValue === false) {
        return { result: { objectId: 'composer-obj-1' } };
      }
      return { result: { value: { ok: true } } };
    }
    if (method === 'DOM.describeNode' && params && params.objectId === 'composer-obj-1') {
      return { node: { nodeType: 1, nodeName: 'FORM', children: [] } };
    }
    if (method === 'DOM.describeNode' && params && params.backendNodeId === 909) {
      return { node: { nodeName: 'INPUT', attributes: ['type', 'file', 'accept', '.md,.pdf'] } };
    }
    if (method === 'DOM.resolveNode' && params && params.backendNodeId === 909) {
      return { object: { objectId: 'chooser-input-909' } };
    }
    if (method === 'Runtime.callFunctionOn') return { result: { value: { ok: true } } };
    if (method === 'Page.setInterceptFileChooserDialog') return {};
    if (method === 'DOM.setFileInputFiles') return {};
    throw new Error(`unexpected CDP call ${method}`);
  });

  const result = await helpers.uploadToGeminiPage(cdp, '/tmp/doc.md', 'document', {
    triggerFn: async () => {
      const interceptIdx = cdp.calls.findIndex(
        (c) => c.method === 'Page.setInterceptFileChooserDialog' && c.params.enabled === true,
      );
      assert.ok(interceptIdx >= 0);
      cdp.emit('Page.fileChooserOpened', { frameId: 'main-frame-1', backendNodeId: 909 });
    },
  });
  assert.equal(result.mechanism, 'dynamic_file_chooser');
  assert.equal(
    cdp.calls.some((c) => c.method === 'Page.setInterceptFileChooserDialog' && c.params.enabled === false),
    true,
  );
  assert.equal(
    cdp.calls.some((c) => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('delete window.__ask_bridge_upload_token')),
    true,
  );

  // Also verify wrong frameId is rejected without calling setFileInputFiles and still cleans up.
  const wrongFrameCdp = makeFakeCdp((method, params) => {
    if (method === 'Page.enable' || method === 'DOM.enable') return {};
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame-1' } } };
    if (method === 'Runtime.evaluate') {
      if (params && params.returnByValue === false) {
        return { result: { objectId: 'composer-obj-1' } };
      }
      return { result: { value: { ok: true } } };
    }
    if (method === 'DOM.describeNode' && params && params.objectId === 'composer-obj-1') {
      return { node: { nodeType: 1, nodeName: 'FORM', children: [] } };
    }
    if (method === 'Page.setInterceptFileChooserDialog') return {};
    throw new Error(`unexpected CDP call ${method}`);
  });

  await assert.rejects(
    helpers.uploadToGeminiPage(wrongFrameCdp, '/tmp/doc.md', 'document', {
      triggerFn: async () => {
        wrongFrameCdp.emit('Page.fileChooserOpened', { frameId: 'evil-subframe', backendNodeId: 909 });
      },
    }),
    /frameId mismatch/,
  );
  assert.equal(wrongFrameCdp.calls.some((c) => c.method === 'DOM.setFileInputFiles'), false);
  assert.equal(
    wrongFrameCdp.calls.some((c) => c.method === 'Page.setInterceptFileChooserDialog' && c.params.enabled === false),
    true,
  );
  assert.equal(
    wrongFrameCdp.calls.some((c) => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('delete window.__ask_bridge_upload_token')),
    true,
  );
});

test('V2-R2: persistent wrong-type input fails closed without entering chooser, Step 2 click=false aborts cleanly, and Shadow DOM piercing checks ownerDocument', async () => {
  const helpers = loadGeminiUploadHelpers();
  const doc = { nodeType: 9 };
  const composerNode = { ownerDocument: doc };
  const shadowRootNode = { ownerDocument: doc, host: composerNode, parentNode: null };
  const shadowInput = { ownerDocument: doc, parentNode: shadowRootNode };
  const iframeDoc = { nodeType: 9 };
  const iframeInput = { ownerDocument: iframeDoc, parentNode: shadowRootNode };

  assert.equal(helpers.isWithinContainerShadowPiercing(composerNode, shadowInput, doc), true);
  assert.equal(helpers.isWithinContainerShadowPiercing(composerNode, iframeInput, doc), false);

  // Persistent input accept mismatch (image/* only) when uploading document MUST fail closed and NEVER intercept fileChooser.
  const wrongAcceptCdp = makeFakeCdp((method, params) => {
    if (method === 'Page.enable' || method === 'DOM.enable') return {};
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame-1' } } };
    if (method === 'Runtime.evaluate' && params.returnByValue === false) return { result: { objectId: 'composer-obj-1' } };
    if (method === 'Runtime.evaluate') return { result: { value: true } };
    if (method === 'DOM.describeNode' && params.objectId === 'composer-obj-1') {
      return { node: { nodeType: 1, nodeName: 'FORM', children: [{ nodeType: 1, nodeName: 'INPUT', attributes: ['type', 'file', 'accept', 'image/*'], backendNodeId: 505 }] } };
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'input-obj-505' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
    throw new Error(`unexpected ${method}`);
  });
  await assert.rejects(
    helpers.uploadToGeminiPage(wrongAcceptCdp, '/tmp/report.md', 'document'),
    /does not accept uploadKind/,
  );
  assert.equal(
    wrongAcceptCdp.calls.some((c) => c.method === 'Page.setInterceptFileChooserDialog' && c.params.enabled === true),
    false,
  );
  assert.equal(wrongAcceptCdp.calls.some((c) => c.method === 'DOM.setFileInputFiles'), false);

  // Step 2 click returning false with stray dialog chooser event MUST NOT call DOM.setFileInputFiles.
  const step2FalseCdp = makeFakeCdp((method, params) => {
    if (method === 'Page.enable' || method === 'DOM.enable') return {};
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame-1' } } };
    if (method === 'Runtime.evaluate' && params.returnByValue === false) return { result: { objectId: 'composer-obj-1' } };
    if (method === 'DOM.describeNode' && params.objectId === 'composer-obj-1') {
      return { node: { nodeType: 1, nodeName: 'FORM', children: [] } };
    }
    if (method === 'Page.setInterceptFileChooserDialog') return {};
    if (method === 'Runtime.callFunctionOn') return { result: { value: { clicked: true } } };
    if (method === 'Runtime.evaluate') {
      if (String(params.expression).includes('delete window.__ask_bridge_upload_token')) return {};
      // Stray unrelated dialog emits chooser even though Step 2 returns clicked: false!
      step2FalseCdp.emit('Page.fileChooserOpened', { frameId: 'main-frame-1', backendNodeId: 999 });
      return { result: { value: false } };
    }
    throw new Error(`unexpected ${method}`);
  });
  await assert.rejects(
    helpers.uploadToGeminiPage(step2FalseCdp, '/tmp/report.md', 'document', {
      setTimeoutFn: (fn) => setTimeout(fn, 1),
    }),
    /menu upload item click failed/,
  );
  assert.equal(step2FalseCdp.calls.some((c) => c.method === 'DOM.setFileInputFiles'), false);
});

test('V3-R1: inputAcceptsKind handles .png/extensions accurately, composer locks inner container over outer form, and ambiguous ARIA menus fail closed', async () => {
  const helpers = loadGeminiUploadHelpers();

  // 1. Extension and MIME matching.
  assert.equal(helpers.inputAcceptsKind('.png', 'image'), true);
  assert.equal(helpers.inputAcceptsKind('.png', 'document'), false);
  assert.equal(helpers.inputAcceptsKind('.jpg,.webp', 'image'), true);
  assert.equal(helpers.inputAcceptsKind('.jpg,.webp', 'document'), false);
  assert.equal(helpers.inputAcceptsKind('.pdf,.md', 'document'), true);
  assert.equal(helpers.inputAcceptsKind('.pdf,.md', 'image'), false);
  assert.equal(helpers.inputAcceptsKind('image/*', 'image'), true);
  assert.equal(helpers.inputAcceptsKind('image/*', 'document'), false);
  assert.equal(helpers.inputAcceptsKind('*/*', 'image'), true);
  assert.equal(helpers.inputAcceptsKind('*/*', 'document'), true);

  // 2. Nested form: outer <form> has unrelated <input type="file">, inner rich-textarea has none -> resolves inner container!
  const expr = helpers.buildResolveComposerContextExpression('tok-nested');
  const innerTextarea = {
    tagName: 'RICH-TEXTAREA',
    matches: (sel) => sel === 'rich-textarea',
    closest(sel) {
      if (sel === 'rich-textarea') return innerTextarea;
      if (sel === 'form') return outerForm;
      return null;
    },
    contains: () => false,
  };
  const outerForm = {
    tagName: 'FORM',
    closest: () => null,
    contains: (el) => el === innerTextarea || el === textbox,
  };
  const textbox = {
    tagName: 'DIV',
    closest: (sel) => innerTextarea.closest(sel),
    contains: () => false,
    getBoundingClientRect: () => ({ width: 300, height: 48 }),
  };
  const resolvedContainer = vm.runInNewContext(expr, {
    window: {
      location: { origin: helpers.GEMINI_ORIGIN },
      __ask_bridge_upload_token: 'tok-nested',
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    },
    document: {
      body: { tagName: 'BODY' },
      documentElement: { tagName: 'HTML' },
      querySelectorAll: (sel) => (sel.includes('textbox') ? [textbox] : []),
    },
  });
  assert.equal(resolvedContainer, innerTextarea);

  // 3. Real Step 1 -> Step 2: two distinct ARIA targets fail closed.
  const ambiguous = makeAriaStepHarness({
    ariaControls: 'menu-a',
    ariaOwns: 'menu-b',
  });
  await assert.rejects(
    helpers.uploadToGeminiPage(ambiguous.cdp, '/tmp/s01.png', 'image', {
      setTimeoutFn: (fn) => setTimeout(fn, 1),
    }),
    /ambiguous_aria_menu_targets/,
  );
  assert.equal(
    ambiguous.cdp.calls.filter((c) => c.method === 'Runtime.callFunctionOn'
      && String(c.params.functionDeclaration).includes('__ask_bridge_pre_menus_v1')).length,
    1,
  );
  assert.equal(
    ambiguous.cdp.calls.some((c) => c.method === 'DOM.setFileInputFiles'),
    false,
  );

  // 4. The same ARIA target reached through both attributes is deduplicated as one menu.
  const unique = makeAriaStepHarness({
    ariaControls: 'menu-a',
    ariaOwns: 'menu-a',
  });
  const result = await helpers.uploadToGeminiPage(unique.cdp, '/tmp/s01.png', 'image', {
    setTimeoutFn: (fn) => setTimeout(fn, 1),
  });
  assert.equal(result.mechanism, 'dynamic_file_chooser');
  assert.equal(
    unique.cdp.calls.filter((c) => c.method === 'Runtime.callFunctionOn'
      && String(c.params.functionDeclaration).includes('__ask_bridge_pre_menus_v1')).length,
    1,
  );
  assert.equal(
    unique.cdp.calls.filter((c) => c.method === 'DOM.setFileInputFiles').length,
    1,
  );
});
