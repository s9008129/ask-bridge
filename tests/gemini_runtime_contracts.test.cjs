const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

process.env.ASK_BRIDGE_UPLOAD_NO_AUTORUN = '1';
process.env.ASK_BRIDGE_DOWNLOAD_NO_AUTORUN = '1';

const {
    findScopedFileInputs,
    validateChooserInputNode,
    run: runGeminiUpload,
} = require('../src/gemini_upload.js');

const {
    geminiConversationId,
    isGeminiGenerating,
    geminiTurnIdentity,
    findGeminiFinalGeneratedImages,
    findGeminiFullSizeDownloadButton,
    geminiElementToMarkdown,
} = require('../src/gemini_turn_projection.js');

const {
    geminiIsAuthControl,
    probeGeminiLoginStability,
} = require('../src/gemini_login_probe.js');

const {
    selectGeminiMode,
} = require('../src/gemini_model_selector.js');

const {
    geminiMatchesExactFilename,
    projectGeminiAttachments,
    geminiPreClickVerify,
} = require('../src/gemini_attachment_projection.js');

const {
    isPrivateOrLoopbackIp,
    decodeDataImageUrl,
    resolveAndValidatePublicAddress,
    fetchWithValidatedRedirects,
    tryReadCachedResourceViaCdp,
    MAX_IMAGE_BYTES,
} = require('../src/gemini_download.js');

// --- R2: Gemini upload CDP scoping & chooser binding negative tests ---
test('R2: findScopedFileInputs never bypasses accept mismatch for single input', () => {
    const composerTree = {
        nodeName: 'FORM',
        children: [
            {
                nodeName: 'INPUT',
                backendNodeId: 101,
                attributes: ['type', 'file', 'accept', 'image/png,image/jpeg'],
            },
        ],
    };
    assert.deepEqual(findScopedFileInputs(composerTree, 'document'), []);
    assert.equal(findScopedFileInputs(composerTree, 'image').length, 1);
});

test('R2: validateChooserInputNode rejects mismatched frameId, non-input, accept mismatch, and outside-composer element', async () => {
    const makeCdp = ({ nodeName = 'INPUT', attrs = ['type', 'file', 'accept', '*/*'], resolveOk = true, scopeResult = { ok: true } } = {}) => ({
        async call(method) {
            if (method === 'DOM.describeNode') {
                return { node: { nodeName, attributes: attrs } };
            }
            if (method === 'DOM.resolveNode') {
                return resolveOk ? { object: { objectId: 'input-obj-1' } } : {};
            }
            if (method === 'Runtime.callFunctionOn') {
                return { result: { value: scopeResult } };
            }
            throw new Error(`unexpected ${method}`);
        },
    });

    await assert.rejects(
        () => validateChooserInputNode(makeCdp(), { frameId: 'subframe-9', backendNodeId: 11 }, 'main-1', 'comp-1', 'image'),
        /frameId mismatch/,
    );
    await assert.rejects(
        () => validateChooserInputNode(makeCdp({ nodeName: 'DIV' }), { frameId: 'main-1', backendNodeId: 11 }, 'main-1', 'comp-1', 'image'),
        /not INPUT/,
    );
    await assert.rejects(
        () => validateChooserInputNode(makeCdp({ attrs: ['type', 'file', 'accept', 'image/png'] }), { frameId: 'main-1', backendNodeId: 11 }, 'main-1', 'comp-1', 'document'),
        /does not match uploadKind/,
    );
    await assert.rejects(
        () => validateChooserInputNode(makeCdp({ scopeResult: { ok: false, reason: 'outside_composer_and_upload_overlay' } }), { frameId: 'main-1', backendNodeId: 11 }, 'main-1', 'comp-1', 'image'),
        /outside_composer_and_upload_overlay/,
    );
});

test('R2: upload run rejects non-unique owned targets and premature chooser before trigger click', async () => {
    class MockWs {
        constructor(url) {
            this.url = url;
            this.listeners = new Map();
            queueMicrotask(() => this._emit('open', {}));
        }
        addEventListener(type, fn) {
            if (!this.listeners.has(type)) this.listeners.set(type, new Set());
            this.listeners.get(type).add(fn);
        }
        removeEventListener(type, fn) {
            const set = this.listeners.get(type);
            if (set) set.delete(fn);
        }
        _emit(type, ev) {
            for (const fn of [...(this.listeners.get(type) || [])]) fn(ev);
        }
        send(raw) {
            const msg = JSON.parse(raw);
            let result = {};
            if (msg.method === 'Runtime.evaluate' && msg.params.expression === 'window.__ask_bridge_upload_token') {
                result = { result: { value: 'tok-1' } };
            } else if (msg.method === 'Runtime.evaluate' && msg.params.returnByValue === false) {
                result = { result: { objectId: 'composer-obj-1' } };
            } else if (msg.method === 'Page.getFrameTree') {
                result = { frameTree: { frame: { id: 'main-frame-1' } } };
            } else if (msg.method === 'DOM.describeNode') {
                result = { node: { nodeName: 'FORM', children: [] } };
            } else if (msg.method === 'Runtime.callFunctionOn') {
                // Emit a premature fileChooserOpened BEFORE clickDispatched flips true on menu click!
                queueMicrotask(() => this._emit('message', {
                    data: JSON.stringify({
                        method: 'Page.fileChooserOpened',
                        params: { frameId: 'main-frame-1', backendNodeId: 99 },
                    }),
                }));
                result = { result: { value: { clicked: true } } };
            }
            queueMicrotask(() => this._emit('message', {
                data: JSON.stringify({ id: msg.id, result }),
            }));
        }
        close() {}
    }

    await assert.rejects(
        () => runGeminiUpload({
            token: 'tok-1',
            filePath: '/tmp/a.png',
            uploadKind: 'image',
            WebSocketCtor: MockWs,
            fetch: async () => ({
                json: async () => ([
                    { type: 'page', url: 'https://gemini.google.com/app', webSocketDebuggerUrl: 'ws://1' },
                    { type: 'page', url: 'https://gemini.google.com/app/abc', webSocketDebuggerUrl: 'ws://2' },
                ]),
            }),
        }),
        /Owned Gemini target was not unique/,
    );

    await assert.rejects(
        () => runGeminiUpload({
            token: 'tok-1',
            filePath: '/tmp/a.png',
            uploadKind: 'image',
            WebSocketCtor: MockWs,
            fetch: async () => ({
                json: async () => ([
                    { type: 'page', url: 'https://gemini.google.com/app', webSocketDebuggerUrl: 'ws://1' },
                ]),
            }),
            timeoutMs: 2000,
        }),
        /fired before upload click dispatch/,
    );
});

// --- R4: Gemini login probe AUTH_RE separate field + 750ms continuous positive window ---
test('R4: geminiIsAuthControl checks separate fields without string-joining bypass', () => {
    const visible = () => true;
    const dualFieldBtn = {
        tagName: 'BUTTON',
        getAttribute: (name) => (name === 'aria-label' ? '登入' : ''),
        innerText: '登入',
        textContent: '登入',
    };
    assert.equal(geminiIsAuthControl(dualFieldBtn, visible), true);

    const serviceLoginLink = {
        tagName: 'A',
        getAttribute: (name) => (name === 'href' ? 'https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com' : ''),
        innerText: 'Continue',
        textContent: 'Continue',
    };
    assert.equal(geminiIsAuthControl(serviceLoginLink, visible), true);

    const benignBtn = {
        tagName: 'BUTTON',
        getAttribute: (name) => (name === 'aria-label' ? 'Send prompt' : ''),
        innerText: 'Send',
        textContent: 'Send',
    };
    assert.equal(geminiIsAuthControl(benignBtn, visible), false);
});

test('R4: probeGeminiLoginStability rejects transient single-tick positive and requires >=750ms continuous stability', async () => {
    let clock = 1000;
    const transientTicks = [
        { account: true, composer: true, auth_control: false, auth_path: false },
        { account: false, composer: false, auth_control: true, auth_path: true },
    ];
    let idx = 0;
    const transientRes = await probeGeminiLoginStability({
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        readSignals: () => transientTicks[Math.min(idx++, transientTicks.length - 1)],
        pollIntervalMs: 150,
    });
    assert.equal(transientRes.auth_path, true);
    assert.equal(transientRes.stable, true);

    clock = 2000;
    const steadyRes = await probeGeminiLoginStability({
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        readSignals: () => ({ account: true, composer: true, auth_control: false, auth_path: false }),
        pollIntervalMs: 200,
    });
    assert.equal(steadyRes.stable, true);
    assert.ok(clock - 2000 >= 800, 'must wait >=800ms before claiming logged-in stability');

    // Flicker at 400ms resets positive timer so total stability window stretches cleanly
    clock = 5000;
    let flickerIdx = 0;
    const flickerTicks = [
        { account: true, composer: true, auth_control: false, auth_path: false },
        { account: true, composer: true, auth_control: false, auth_path: false },
        { account: false, composer: true, auth_control: false, auth_path: false }, // 400ms reset!
        { account: true, composer: true, auth_control: false, auth_path: false },
        { account: true, composer: true, auth_control: false, auth_path: false },
        { account: true, composer: true, auth_control: false, auth_path: false },
        { account: true, composer: true, auth_control: false, auth_path: false },
        { account: true, composer: true, auth_control: false, auth_path: false },
    ];
    const flickerRes = await probeGeminiLoginStability({
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        readSignals: () => flickerTicks[Math.min(flickerIdx++, flickerTicks.length - 1)],
        pollIntervalMs: 200,
    });
    assert.equal(flickerRes.stable, true);
    assert.ok(clock - 5000 >= 1200, 'negative tick must reset the 750ms continuous positive timer');
});

// --- R5 & R6: Gemini shared turn projection + placeholder filtering + markdown conversion ---
test('R5: geminiTurnIdentity never falls back to tag name and rejects loading/placeholder images', () => {
    const bareGroup = {
        scope: { tagName: 'MODEL-RESPONSE', getAttribute: () => '' },
        nodes: [{
            tagName: 'MODEL-RESPONSE',
            getAttribute: () => '',
            querySelectorAll: (sel) => {
                if (sel === 'img' || sel.includes('img')) {
                    return [
                        {
                            currentSrc: 'https://lh3.googleusercontent.com/placeholder-preview.png',
                            complete: true,
                            naturalWidth: 1024,
                            naturalHeight: 1024,
                            parentElement: { tagName: 'DIV', className: 'shimmer-placeholder', getAttribute: () => 'true' },
                            getAttribute: () => '',
                        },
                        {
                            currentSrc: 'https://lh3.googleusercontent.com/final-render-1.png',
                            complete: true,
                            naturalWidth: 1024,
                            naturalHeight: 1024,
                            parentElement: {
                                tagName: 'GENERATED-IMAGE',
                                className: 'generated',
                                getAttribute: (k) => (k === 'id' ? 'img-artifact-1' : ''),
                            },
                            getAttribute: () => '',
                        },
                    ];
                }
                if (sel.includes('aria-busy') || sel.includes('progressbar')) {
                    return [];
                }
                return [{ tagName: 'GENERATED-IMAGE', getAttribute: () => '' }];
            },
        }],
    };
    const identity = geminiTurnIdentity(bareGroup);
    assert.equal(identity.turnId, '');
    assert.deepEqual(identity.artifactIds, []);

    const imgs = findGeminiFinalGeneratedImages(bareGroup, 200);
    assert.equal(imgs.length, 1);
    assert.deepEqual(imgs[0], {
        artifactId: 'img-artifact-1',
        src: 'https://lh3.googleusercontent.com/final-render-1.png',
        naturalWidth: 1024,
        naturalHeight: 1024,
    });
    assert.equal(geminiConversationId('https://gemini.google.com/u/1/app/conv-42'), 'conversation:conv-42');
    assert.equal(isGeminiGenerating(null, bareGroup, [], () => true), false);
});

test('V2-R5: findGeminiFinalGeneratedImages rejects non-container illustrations, user-query images, and containers missing artifactId', () => {
    const groupWithIllustrationAndBadContainers = {
        scope: { tagName: 'MODEL-RESPONSE', getAttribute: () => 'resp-9' },
        nodes: [{
            tagName: 'MODEL-RESPONSE',
            querySelectorAll(sel) {
                if (sel.includes('generated-image')) {
                    return [
                        // Valid container, valid artifactId, inside user-query -> MUST reject!
                        {
                            currentSrc: 'https://lh3.googleusercontent.com/user-ref.png',
                            complete: true,
                            naturalWidth: 1024,
                            naturalHeight: 1024,
                            parentElement: {
                                tagName: 'GENERATED-IMAGE',
                                getAttribute: (k) => (k === 'id' ? 'user-img-1' : ''),
                                parentElement: { tagName: 'USER-QUERY', getAttribute: () => '' },
                            },
                            getAttribute: () => '',
                        },
                        // Container missing identifying artifactId -> MUST reject!
                        {
                            currentSrc: 'https://lh3.googleusercontent.com/no-id.png',
                            complete: true,
                            naturalWidth: 1024,
                            naturalHeight: 1024,
                            parentElement: {
                                tagName: 'GENERATED-IMAGE',
                                getAttribute: (k) => (k === 'id' ? 'generated-image' : ''),
                            },
                            getAttribute: () => '',
                        },
                    ];
                }
                // Bare <img> fallback would return general illustration, must NOT be queried!
                if (sel === 'img') {
                    return [{
                        currentSrc: 'https://lh3.googleusercontent.com/general-illustration.png',
                        complete: true,
                        naturalWidth: 1024,
                        naturalHeight: 1024,
                        getAttribute: () => '',
                    }];
                }
                return [];
            },
        }],
    };
    assert.deepEqual(findGeminiFinalGeneratedImages(groupWithIllustrationAndBadContainers, 200), []);
});

test('R6: geminiElementToMarkdown preserves fenced code blocks and skips screen-reader/button noise', () => {
    const fakeTree = {
        nodeType: 1,
        tagName: 'DIV',
        childNodes: [
            { nodeType: 1, tagName: 'BUTTON', className: '', childNodes: [{ nodeType: 3, textContent: 'Copy' }] },
            { nodeType: 1, tagName: 'H2', className: '', childNodes: [{ nodeType: 3, textContent: 'Summary' }] },
            {
                nodeType: 1,
                tagName: 'PRE',
                className: '',
                querySelector: (s) => (s === 'code' ? { classList: ['language-python'], textContent: 'print("hi")\n' } : null),
            },
        ],
    };
    const md = geminiElementToMarkdown(fakeTree);
    assert.match(md, /## Summary/);
    assert.match(md, /```python\nprint\("hi"\)\n\n?```/);
    assert.doesNotMatch(md, /Copy/);
});

// --- R7: Gemini mode menu exact readback & remount re-query ---
test('R7: selectGeminiMode rejects substring-only match, re-queries remounted button, and verifies reopened checked item', async () => {
    const makeEl = (tag, { text = '', ariaLabel = '', checked = false, disabled = false, role = '' } = {}) => ({
        tagName: tag,
        innerText: text,
        textContent: text,
        disabled,
        hasAttribute: () => disabled,
        getAttribute: (k) => {
            if (k === 'aria-label') return ariaLabel;
            if (k === 'aria-checked') return checked ? 'true' : 'false';
            if (k === 'aria-selected') return checked ? 'true' : 'false';
            if (k === 'role') return role;
            return '';
        },
        querySelector: () => null,
        click() { if (this._onClick) this._onClick(); },
    });

    // Case 1: Remounted button shows localized ambiguous substring ("3.1 Pro Preview" vs "3.1 Pro")
    // -> must reopen menu, check exact checked target, and fail if another item is also checked!
    let menuOpen = false;
    let conflicting = true;
    const itemPro = makeEl('BUTTON', { text: '3.1 Pro', checked: false, role: 'menuitemradio' });
    const itemFlash = makeEl('BUTTON', { text: '3.5 Flash', checked: true, role: 'menuitemradio' });
    let buttonInstance = 0;

    itemPro._onClick = () => {
        menuOpen = false;
        buttonInstance += 1;
        itemPro.getAttribute = (k) => {
            if (k === 'aria-checked') return 'true';
            if (k === 'role') return 'menuitemradio';
            return '';
        };
        if (!conflicting) {
            itemFlash.getAttribute = (k) => (k === 'role' ? 'menuitemradio' : 'false');
        }
    };

    const doc = {
        querySelectorAll(sel) {
            if (sel === 'button') {
                const btn = makeEl('BUTTON', {
                    text: '3.1 Pro Preview (Extra)',
                    ariaLabel: `模式挑選器-${buttonInstance}`,
                });
                btn._onClick = () => { menuOpen = true; };
                return [btn];
            }
            if (sel.includes('menuitem')) {
                return menuOpen ? [itemPro, itemFlash] : [];
            }
            return [];
        },
    };

    const failStatus = await selectGeminiMode('3.1 Pro', {
        doc,
        sleep: async () => {},
        isVisible: () => true,
        dispatchEscape: () => { menuOpen = false; },
    });
    assert.equal(failStatus, 'error: Gemini model selection readback mismatch');

    conflicting = false;
    const okStatus = await selectGeminiMode('3.1 Pro', {
        doc,
        sleep: async () => {},
        isVisible: () => true,
        dispatchEscape: () => { menuOpen = false; },
    });
    assert.equal(okStatus, 'success:gemini_mode_menu_v1');
});

// --- R8: SSRF / DNS Pinning / Streaming Byte Cutoff / Pre-decode Size Caps ---
test('R8: isPrivateOrLoopbackIp blocks multicast, reserved, benchmarking, and hex/dotted v6-mapped IPs', () => {
    assert.equal(isPrivateOrLoopbackIp('224.0.0.1'), true);
    assert.equal(isPrivateOrLoopbackIp('240.0.0.1'), true);
    assert.equal(isPrivateOrLoopbackIp('198.18.0.1'), true);
    assert.equal(isPrivateOrLoopbackIp('ff02::1'), true);
    assert.equal(isPrivateOrLoopbackIp('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateOrLoopbackIp('::ffff:7f00:1'), true);
    assert.equal(isPrivateOrLoopbackIp('0:0:0:0:0:ffff:0a00:0001'), true);
    assert.equal(isPrivateOrLoopbackIp('142.250.190.46'), false);
    assert.equal(isPrivateOrLoopbackIp('2607:f8b0:4005:80b::200e'), false);
});

test('R8: resolveAndValidatePublicAddress rejects mixed public+private DNS answers', async () => {
    await assert.rejects(
        () => resolveAndValidatePublicAddress('https://lh3.googleusercontent.com/img.png', async () => ([
            { address: '142.250.190.46', family: 4 },
            { address: '10.0.0.5', family: 4 },
        ])),
        /Blocked private\/non-public DNS address/,
    );
});

test('R8: fetchWithValidatedRedirects aborts chunked overflow stream immediately before exceeding maxBytes', async () => {
    let reqDestroyed = false;
    let resDestroyed = false;
    const mockHttps = {
        request(_opts, cb) {
            const req = new EventEmitter();
            req.destroyed = false;
            req.setTimeout = () => {};
            req.destroy = () => { req.destroyed = true; reqDestroyed = true; };
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 200;
                res.headers = {}; // Chunked, no Content-Length!
                res.destroyed = false;
                res.destroy = () => { res.destroyed = true; resDestroyed = true; };
                res.resume = () => {};
                cb(res);
                res.emit('data', Buffer.alloc(600));
                res.emit('data', Buffer.alloc(600));
            };
            return req;
        },
    };

    await assert.rejects(
        () => fetchWithValidatedRedirects('https://lh3.googleusercontent.com/test.png', {
            maxBytes: 1000,
            lookupAll: async () => [{ address: '142.250.190.46', family: 4 }],
            httpsModule: mockHttps,
        }),
        /exceeds maximum allowed bytes/,
    );
    assert.equal(reqDestroyed, true);
    assert.equal(resDestroyed, true);
});

test('R8: decodeDataImageUrl and tryReadCachedResourceViaCdp enforce pre-allocation maxBytes cap', async () => {
    const oversizedBase64 = 'A'.repeat(200);
    assert.throws(
        () => decodeDataImageUrl(`data:image/png;base64,${oversizedBase64}`, 64),
        /before decode/,
    );
    const mockWs = {
        listeners: new Set(),
        addEventListener(_t, fn) { this.listeners.add(fn); },
        removeEventListener(_t, fn) { this.listeners.delete(fn); },
        send(raw) {
            const msg = JSON.parse(raw);
            let result = {};
            if (msg.method === 'Page.getResourceTree') {
                result = { frameTree: { frame: { id: 'f1' } } };
            } else if (msg.method === 'Page.getResourceContent') {
                result = { base64Encoded: true, content: 'A'.repeat(400) };
            }
            for (const fn of [...this.listeners]) fn({ data: JSON.stringify({ id: msg.id, result }) });
        },
    };
    await assert.rejects(
        () => tryReadCachedResourceViaCdp(mockWs, 'https://lh3.googleusercontent.com/x.png', 100),
        /before decode/,
    );
    assert.equal(MAX_IMAGE_BYTES, 50 * 1024 * 1024);
});

// --- V2-R3, V2-R4, V2-R6 negative contract tests ---
test('V2-R3: shared Gemini attachment projection enforces exact filename, zero-image delta, and text uploading/error gates', () => {
    assert.equal(geminiMatchesExactFilename('report.md', 'report.md'), true);
    assert.equal(geminiMatchesExactFilename('report(1).md', 'report.md'), true);
    assert.equal(geminiMatchesExactFilename('backup-report.md', 'report.md'), false);
    assert.equal(geminiMatchesExactFilename('my_report.md', 'report.md'), false);
    assert.equal(geminiMatchesExactFilename('report.md.bak', 'report.md'), false);

    const makeComposerRoot = (chips, imgs = []) => ({
        querySelectorAll(sel) {
            if (sel.includes('file-chip')) return chips;
            if (sel.includes('uploader-image-preview')) return imgs.map((img) => ({ querySelectorAll: () => [img] }));
            return [];
        },
    });
    const backupChip = {
        innerText: 'backup-report.md',
        textContent: 'backup-report.md',
        getAttribute: () => '',
        querySelectorAll: () => [],
        querySelector: () => null,
    };
    const backupCheck = geminiPreClickVerify(makeComposerRoot([backupChip]), ['report.md'], 0, {}, () => true);
    assert.equal(backupCheck.ok, false);

    const reportChip = {
        innerText: 'report.md',
        textContent: 'report.md',
        getAttribute: () => '',
        querySelectorAll: () => [],
        querySelector: () => null,
    };
    const extraImg = { currentSrc: 'https://lh3.googleusercontent.com/extra.png', complete: true, naturalWidth: 512, naturalHeight: 512 };
    const zeroImageExtraCheck = geminiPreClickVerify(makeComposerRoot([reportChip], [extraImg]), ['report.md'], 0, {}, () => true);
    assert.equal(zeroImageExtraCheck.ok, false);
    assert.equal(zeroImageExtraCheck.reason, 'unexpected_image_before_click');

    const profileThumb = {
        currentSrc: 'https://lh3.googleusercontent.com/profile.png',
        src: 'https://lh3.googleusercontent.com/profile.png',
        complete: true,
        naturalWidth: 512,
        naturalHeight: 512,
        parentElement: null,
    };
    const profileProj = projectGeminiAttachments(makeComposerRoot([reportChip], [profileThumb]), ['report.md'], {}, () => true);
    assert.equal(profileProj.newImageCount, 1);
    const profileCheck = geminiPreClickVerify(makeComposerRoot([reportChip], [profileThumb]), ['report.md'], 0, {}, () => true);
    assert.equal(profileCheck.ok, false);
    assert.equal(profileCheck.reason, 'unexpected_image_before_click');

    const domAvatar = {
        currentSrc: 'https://lh3.googleusercontent.com/neutral-name.png',
        src: 'https://lh3.googleusercontent.com/neutral-name.png',
        complete: true,
        naturalWidth: 512,
        naturalHeight: 512,
        parentElement: { matches: () => true },
    };
    const avatarProj = projectGeminiAttachments(makeComposerRoot([reportChip], [domAvatar]), ['report.md'], {}, () => true);
    assert.equal(avatarProj.newImageCount, 0);

    const uploadingChip = {
        innerText: 'report.md\n上傳中',
        textContent: 'report.md 上傳中',
        getAttribute: () => '',
        querySelectorAll: () => [],
        querySelector: () => null,
    };
    const projUploading = projectGeminiAttachments(makeComposerRoot([uploadingChip]), ['report.md'], {}, () => true);
    assert.equal(projUploading.uploading, true);
    assert.equal(geminiPreClickVerify(makeComposerRoot([uploadingChip]), ['report.md'], 0, {}, () => true).ok, false);
});

test('V5-R2: nested attachment previews use their innermost boundary while real avatars stay excluded', () => {
    const makeImage = (src, testid = '') => ({
        currentSrc: src,
        src,
        complete: true,
        naturalWidth: 512,
        naturalHeight: 512,
        matches: (selector) => Boolean(testid)
            && selector.includes('[data-testid*="avatar"')
            && testid.toLowerCase().includes('avatar'),
        getAttribute: (name) => (name === 'data-testid' ? testid : ''),
        getBoundingClientRect: () => ({ width: 50, height: 50 }),
        querySelectorAll: () => [],
        parentElement: null,
    });
    const makeNode = (attrs = {}) => {
        const node = {
            textContent: '',
            innerText: '',
            imgs: [],
            children: [],
            parentElement: null,
            getAttribute: (name) => attrs[name] || '',
            getBoundingClientRect: () => ({ width: 50, height: 24 }),
            matches: (selector) => {
                const testid = String(attrs['data-testid'] || '').toLowerCase();
                return Boolean(testid)
                    && selector.includes('[data-testid*="avatar"')
                    && testid.includes('avatar');
            },
            querySelector: (selector) => (selector === 'img' ? node.imgs[0] || null : null),
            querySelectorAll: (selector) => (selector === 'img' ? node.imgs : []),
            contains: (other) => (
                other === node
                || node.imgs.includes(other)
                || node.children.some((child) => child === other || (typeof child.contains === 'function' && child.contains(other)))
            ),
        };
        return node;
    };
    const reportChip = {
        innerText: 'report.md',
        textContent: 'report.md',
        getAttribute: () => '',
        querySelectorAll: () => [],
        querySelector: () => null,
        getBoundingClientRect: () => ({ width: 50, height: 24 }),
    };
    const makeRoot = (outer, inner, extraContainers = []) => {
        const root = {
            querySelectorAll(selector) {
                if (selector.includes('file-chip')) return [reportChip, outer, ...(inner ? [inner] : [])];
                if (selector.includes('[data-testid*="image"]')) {
                    return [outer, ...(inner ? [inner] : []), ...extraContainers];
                }
                if (selector.includes('attachment')) return [outer, ...(inner ? [inner] : [])];
                if (selector.includes('uploader-image-preview')) return inner ? [inner] : [];
                return [];
            },
        };
        outer.parentElement = root;
        if (inner) inner.parentElement = outer;
        return root;
    };

    const nestedOuter = makeNode({ class: 'attachment-list' });
    const nestedInner = makeNode({ 'data-testid': 'avatar-attachment-preview' });
    const nestedImg = makeImage('blob:https://gemini.google.com/thumb-1');
    nestedImg.parentElement = nestedInner;
    nestedInner.imgs = [nestedImg];
    nestedOuter.children = [nestedInner];
    nestedOuter.imgs = [nestedImg];
    const nestedRoot = makeRoot(nestedOuter, nestedInner);
    const nestedProj = projectGeminiAttachments(nestedRoot, ['report.md'], {}, () => true);
    assert.equal(nestedProj.newImageCount, 1);
    const nestedCheck = geminiPreClickVerify(nestedRoot, ['report.md'], 0, {}, () => true);
    assert.equal(nestedCheck.ok, false);
    assert.equal(nestedCheck.reason, 'unexpected_image_before_click');

    const avatarOuter = makeNode({ class: 'attachment-list' });
    const avatarNode = makeNode({ 'data-testid': 'user-avatar' });
    const avatarImg = makeImage('https://lh3.googleusercontent.com/u/0/photo.jpg');
    avatarImg.parentElement = avatarNode;
    avatarNode.imgs = [avatarImg];
    avatarOuter.children = [avatarNode];
    avatarOuter.imgs = [avatarImg];
    const avatarRoot = makeRoot(avatarOuter, null);
    const avatarProj = projectGeminiAttachments(avatarRoot, ['report.md'], {}, () => true);
    assert.equal(avatarProj.newImageCount, 0);
    assert.equal(geminiPreClickVerify(avatarRoot, ['report.md'], 0, {}, () => true).ok, true);

    const sameImgOuter = makeNode({ class: 'attachment-list' });
    const sameImg = makeImage('https://lh3.googleusercontent.com/u/0/photo.jpg', 'user-avatar-image');
    sameImg.parentElement = sameImgOuter;
    sameImgOuter.imgs = [sameImg];
    const sameImgRoot = makeRoot(sameImgOuter, null, [sameImg]);
    const sameImgProj = projectGeminiAttachments(sameImgRoot, ['report.md'], {}, () => true);
    assert.equal(sameImgProj.newImageCount, 0);
    assert.equal(geminiPreClickVerify(sameImgRoot, ['report.md'], 0, {}, () => true).ok, true);
    const missingReference = geminiPreClickVerify(sameImgRoot, ['report.md'], 1, {}, () => true);
    assert.equal(missingReference.ok, false);
    assert.equal(missingReference.reason, 'image_mismatch_or_not_loaded_before_click');
});

test('V2-R4: login probe catches visible [role="button"] Sign in even with account and composer present', async () => {
    const { readGeminiLoginSignals } = require('../src/gemini_login_probe.js');
    const divRoleBtn = {
        tagName: 'DIV',
        getAttribute: (k) => (k === 'role' ? 'button' : ''),
        innerText: 'Sign in',
        textContent: 'Sign in',
    };
    const fakeDoc = {
        querySelectorAll(sel) {
            if (sel.includes('SignOutOptions')) return [{ tagName: 'A' }];
            if (sel.includes('textbox') || sel.includes('rich-textarea') || sel.includes('ql-editor')) return [{ tagName: 'DIV' }];
            if (sel.includes('[role="button"]')) return [divRoleBtn];
            return [];
        },
    };
    const signals = readGeminiLoginSignals(fakeDoc, { pathname: '/app', hostname: 'gemini.google.com' }, () => true);
    assert.equal(signals.auth_control, true);

    let clock = 0;
    const stability = await probeGeminiLoginStability({
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        readSignals: () => signals,
        maxWaitMs: 1200,
    });
    assert.equal(stability.auth_control, true);
});

test('V2-R6: selectGeminiMode rejects reopened menu when duplicate mode names appear', async () => {
    let menuOpen = false;
    const mk = (text, checked, role = 'menuitemradio') => ({
        tagName: 'BUTTON',
        innerText: text,
        textContent: text,
        disabled: false,
        hasAttribute: () => false,
        getAttribute: (k) => (k === 'aria-checked' ? (checked ? 'true' : 'false') : (k === 'role' ? role : '')),
        querySelector: () => null,
        click() { menuOpen = false; },
    });
    let phase = 0;
    const itemChoice = mk('3.1 Pro', false);
    const dupUnchecked = mk('3.1 Pro', false);
    itemChoice.click = () => { menuOpen = false; phase = 1; };
    const doc = {
        querySelectorAll(sel) {
            if (sel === 'button') {
                return [{
                    tagName: 'BUTTON',
                    innerText: 'Gemini Mode',
                    textContent: 'Gemini Mode',
                    getAttribute: (k) => (k === 'aria-label' ? '模式挑選器' : ''),
                    click() { menuOpen = true; },
                }];
            }
            if (sel.includes('menuitem') && menuOpen) {
                if (phase === 0) return [itemChoice];
                return [mk('3.1 Pro', true), dupUnchecked];
            }
            return [];
        },
    };
    const status = await selectGeminiMode('3.1 Pro', {
        doc,
        sleep: async () => {},
        isVisible: () => true,
        dispatchEscape: () => { menuOpen = false; },
    });
    assert.equal(status, 'error: Gemini model selection readback mismatch');
});

// --- Gemini full-size download button scoping contract ---
function makeFullSizeControl(options = {}) {
    const attrs = options.attrs || {};
    const icons = options.icons || [];
    const control = {
        tagName: options.tagName || 'BUTTON',
        textContent: options.text || '',
        selectorMatch: Boolean(options.selectorMatch),
        clicked: false,
        getAttribute(name) {
            return attrs[name] || '';
        },
        querySelectorAll(selector) {
            if (String(selector).includes('mat-icon')) return icons;
            return [];
        },
        dispatchEvent() { return true; },
        click() { control.clicked = true; },
    };
    return control;
}

function makeFullSizeImage(spec) {
    return {
        tagName: 'IMG',
        currentSrc: spec.src,
        src: spec.src,
        complete: true,
        naturalWidth: spec.width ?? spec.naturalWidth,
        naturalHeight: spec.height ?? spec.naturalHeight,
        getAttribute(name) {
            if (name === 'src') return spec.src;
            return '';
        },
    };
}

function makeFullSizeGroup(containerSpecs) {
    const root = {
        tagName: 'MODEL-RESPONSE',
        getAttribute: (name) => (name === 'id' ? 'response-art-1' : ''),
        querySelectorAll(selector) {
            if (String(selector).includes('generated-image')) {
                return root.__images;
            }
            return [];
        },
        __images: [],
    };
    const containers = containerSpecs.map((spec) => {
        const images = (spec.images || []).map((imageSpec) => makeFullSizeImage(imageSpec));
        const controls = spec.controls || [];
        const container = {
            tagName: 'GENERATED-IMAGE',
            querySelectorAll(selector) {
                if (selector === 'img') return images;
                if (selector === 'button, a, [role="button"]') return controls;
                if (
                    String(selector).includes('download-generated-image-button button')
                    || String(selector).includes('button[data-test-id*="download-generated-image"]')
                ) {
                    return controls.filter((control) => control.selectorMatch);
                }
                return [];
            },
            getAttribute(name) {
                if (name === 'id' || name === 'data-artifact-id') return spec.artifactId;
                return '';
            },
        };
        for (const image of images) image.parentElement = container;
        if (spec.userQuery) {
            const userQuery = {
                tagName: 'USER-QUERY',
                parentElement: root,
                querySelectorAll() { return []; },
                getAttribute() { return ''; },
            };
            container.parentElement = userQuery;
        } else {
            container.parentElement = root;
        }
        root.__images.push(...images);
        return container;
    });
    return { scope: root, nodes: [root], containers };
}

const FULL_SIZE_CANDIDATE = {
    artifactId: 'generated-image-1',
    src: 'https://lh3.googleusercontent.com/final-2752.png',
    naturalWidth: 2752,
    naturalHeight: 1536,
};

test('full-size download button prefers selector, then localized labels, then a unique download icon', () => {
    const selectorButton = makeFullSizeControl({
        selectorMatch: true,
        attrs: { 'data-test-id': 'download-generated-image-button' },
    });
    const labelButton = makeFullSizeControl({ attrs: { 'aria-label': '下載原尺寸' } });
    const iconButton = makeFullSizeControl({
        icons: [{ textContent: 'download', getAttribute: () => '' }],
    });
    const priorityGroup = makeFullSizeGroup([{
        artifactId: FULL_SIZE_CANDIDATE.artifactId,
        images: [FULL_SIZE_CANDIDATE],
        controls: [labelButton, iconButton, selectorButton],
    }]);
    const priority = findGeminiFullSizeDownloadButton(priorityGroup, FULL_SIZE_CANDIDATE, 256);
    assert.equal(priority.ok, true);
    assert.equal(priority.button, selectorButton);
    assert.equal(priority.matchedBy, 'selector');

    for (const label of [
        '下載原尺寸',
        '下載完整尺寸',
        '下载原尺寸',
        'Download full size',
        'Download original size',
        'Download original image',
        'フルサイズでダウンロード',
        '원본 크기로 다운로드',
    ]) {
        const target = makeFullSizeControl({ attrs: { 'aria-label': label } });
        const share = makeFullSizeControl({ attrs: { 'aria-label': '分享' } });
        const group = makeFullSizeGroup([{
            artifactId: FULL_SIZE_CANDIDATE.artifactId,
            images: [FULL_SIZE_CANDIDATE],
            controls: [share, target],
        }]);
        const result = findGeminiFullSizeDownloadButton(group, FULL_SIZE_CANDIDATE, 256);
        assert.equal(result.ok, true, label);
        assert.equal(result.button, target, label);
        assert.equal(result.matchedBy, 'label', label);
    }

    const onlyIcon = makeFullSizeControl({
        icons: [{ textContent: 'download', getAttribute: () => '' }],
    });
    const nonDownload = [
        makeFullSizeControl({ attrs: { 'aria-label': 'Share' } }),
        makeFullSizeControl({ attrs: { 'aria-label': 'Copy' } }),
        makeFullSizeControl({ attrs: { 'aria-label': 'More options' } }),
        makeFullSizeControl({ attrs: { 'aria-label': 'Feedback' } }),
        makeFullSizeControl({ icons: [{ textContent: 'share', getAttribute: () => '' }] }),
        makeFullSizeControl({ icons: [{ textContent: 'copy', getAttribute: () => '' }] }),
        makeFullSizeControl({ icons: [{ textContent: 'more_vert', getAttribute: () => '' }] }),
        makeFullSizeControl({ icons: [{ textContent: 'feedback', getAttribute: () => '' }] }),
    ];
    const iconGroup = makeFullSizeGroup([{
        artifactId: FULL_SIZE_CANDIDATE.artifactId,
        images: [FULL_SIZE_CANDIDATE],
        controls: [...nonDownload, onlyIcon],
    }]);
    const iconResult = findGeminiFullSizeDownloadButton(iconGroup, FULL_SIZE_CANDIDATE, 256);
    assert.equal(iconResult.ok, true);
    assert.equal(iconResult.button, onlyIcon);
    assert.equal(iconResult.matchedBy, 'icon');
});

test('full-size download button fails closed for missing, ambiguous, and multi-image containers', () => {
    const noControls = makeFullSizeGroup([{
        artifactId: FULL_SIZE_CANDIDATE.artifactId,
        images: [FULL_SIZE_CANDIDATE],
        controls: [],
    }]);
    assert.equal(
        findGeminiFullSizeDownloadButton(noControls, FULL_SIZE_CANDIDATE, 256).reason,
        'button_not_found'
    );

    const twoSelectors = makeFullSizeGroup([{
        artifactId: FULL_SIZE_CANDIDATE.artifactId,
        images: [FULL_SIZE_CANDIDATE],
        controls: [
            makeFullSizeControl({ selectorMatch: true }),
            makeFullSizeControl({ selectorMatch: true }),
        ],
    }]);
    assert.equal(
        findGeminiFullSizeDownloadButton(twoSelectors, FULL_SIZE_CANDIDATE, 256).reason,
        'ambiguous_download_button'
    );

    const twoLabels = makeFullSizeGroup([{
        artifactId: FULL_SIZE_CANDIDATE.artifactId,
        images: [FULL_SIZE_CANDIDATE],
        controls: [
            makeFullSizeControl({ attrs: { 'aria-label': 'Download full size' } }),
            makeFullSizeControl({ attrs: { title: '下載原尺寸' } }),
        ],
    }]);
    assert.equal(
        findGeminiFullSizeDownloadButton(twoLabels, FULL_SIZE_CANDIDATE, 256).reason,
        'ambiguous_download_button'
    );

    const twoIcons = makeFullSizeGroup([{
        artifactId: FULL_SIZE_CANDIDATE.artifactId,
        images: [FULL_SIZE_CANDIDATE],
        controls: [
            makeFullSizeControl({ icons: [{ textContent: 'download', getAttribute: () => '' }] }),
            makeFullSizeControl({ icons: [{ textContent: '', getAttribute: (name) => (name === 'data-icon' ? 'download' : '') }] }),
        ],
    }]);
    assert.equal(
        findGeminiFullSizeDownloadButton(twoIcons, FULL_SIZE_CANDIDATE, 256).reason,
        'ambiguous_download_button'
    );

    const extraImageInContainer = makeFullSizeGroup([{
        artifactId: FULL_SIZE_CANDIDATE.artifactId,
        images: [
            FULL_SIZE_CANDIDATE,
            { artifactId: 'generated-image-2', src: 'https://lh3.googleusercontent.com/final-2.png', width: 2752, height: 1536 },
        ],
        controls: [makeFullSizeControl({ selectorMatch: true })],
    }]);
    assert.equal(
        findGeminiFullSizeDownloadButton(extraImageInContainer, FULL_SIZE_CANDIDATE, 256).reason,
        'ambiguous_download_button'
    );

    const duplicateCandidate = makeFullSizeGroup([
        {
            artifactId: FULL_SIZE_CANDIDATE.artifactId,
            images: [FULL_SIZE_CANDIDATE],
            controls: [makeFullSizeControl({ selectorMatch: true })],
        },
        {
            artifactId: FULL_SIZE_CANDIDATE.artifactId,
            images: [FULL_SIZE_CANDIDATE],
            controls: [makeFullSizeControl({ selectorMatch: true })],
        },
    ]);
    assert.equal(
        findGeminiFullSizeDownloadButton(duplicateCandidate, FULL_SIZE_CANDIDATE, 256).reason,
        'ambiguous_download_button'
    );

    const missingCandidate = makeFullSizeGroup([{
        artifactId: 'generated-image-2',
        images: [{ artifactId: 'generated-image-2', src: 'https://lh3.googleusercontent.com/other.png', width: 2752, height: 1536 }],
        controls: [makeFullSizeControl({ selectorMatch: true })],
    }]);
    assert.equal(
        findGeminiFullSizeDownloadButton(missingCandidate, FULL_SIZE_CANDIDATE, 256).reason,
        'button_not_found'
    );
});

test('full-size download button stays inside the verified single-image container', () => {
    const firstButton = makeFullSizeControl({ selectorMatch: true });
    const secondButton = makeFullSizeControl({ selectorMatch: true });
    const isolated = makeFullSizeGroup([
        {
            artifactId: FULL_SIZE_CANDIDATE.artifactId,
            images: [FULL_SIZE_CANDIDATE],
            controls: [firstButton],
        },
        {
            artifactId: 'generated-image-2',
            images: [{
                artifactId: 'generated-image-2',
                src: 'https://lh3.googleusercontent.com/final-2.png',
                width: 2752,
                height: 1536,
            }],
            controls: [secondButton],
        },
    ]);
    const result = findGeminiFullSizeDownloadButton(isolated, FULL_SIZE_CANDIDATE, 256);
    assert.equal(result.ok, true);
    assert.equal(result.button, firstButton);
    assert.notEqual(result.button, secondButton);

    const userQueryOnly = makeFullSizeGroup([{
        artifactId: FULL_SIZE_CANDIDATE.artifactId,
        images: [FULL_SIZE_CANDIDATE],
        controls: [makeFullSizeControl({ selectorMatch: true })],
        userQuery: true,
    }]);
    assert.equal(
        findGeminiFullSizeDownloadButton(userQueryOnly, FULL_SIZE_CANDIDATE, 256).reason,
        'button_not_found'
    );
});
