// Two-phase target-locked CDP Trusted native attachment uploader for Gemini.
// Enforces:
// 1. Page.enable, DOM.enable, Page.getFrameTree mainFrameId verification.
// 2. Composer context pinned as CDP objectId via verifyAndResolveComposerContext(cdp)
//    (never falling back to document.body / documentElement / iframe contentDocument).
// 3. Distinguishes "no persistent input" from "persistent input(s) with accept mismatch or ambiguity"
//    with Shadow-DOM-piercing composer ancestor verification.
// 4. Native file chooser interception ONLY after Step 1 composer upload button -> Step 2 verified
//    menu item click === true -> strict main-frame & proven-origin input validation before DOM.setFileInputFiles.

const [tokenArg, filePathArg, uploadKindArg] = process.argv.slice(1);

const GEMINI_ORIGIN = 'https://gemini.google.com';
const GEMINI_UPLOAD_TIMEOUT_MS = 20000;
const GEMINI_CHOOSER_WAIT_MS = 10000;
const GEMINI_COMPOSER_INPUT_SELECTORS = [
    'div[role="textbox"][aria-label*="Gemini"]',
    'rich-textarea [contenteditable="true"]',
    '.ql-editor[contenteditable="true"]',
];

class CdpSession {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        this._onMessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) {
                    reject(new Error(msg.error.message || 'CDP command failed'));
                } else {
                    resolve(msg.result);
                }
                return;
            }
            if (msg.method && this.listeners.has(msg.method)) {
                for (const fn of [...this.listeners.get(msg.method)]) {
                    try {
                        fn(msg.params || {});
                    } catch (_) {}
                }
            }
        };
        this.ws.addEventListener('message', this._onMessage);
    }

    call(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    on(method, fn) {
        if (!this.listeners.has(method)) {
            this.listeners.set(method, new Set());
        }
        this.listeners.get(method).add(fn);
        return () => {
            const set = this.listeners.get(method);
            if (set) set.delete(fn);
        };
    }

    close() {
        try {
            this.ws.removeEventListener('message', this._onMessage);
            this.ws.close();
        } catch (_) {}
    }
}

function isGeminiPageTarget(page) {
    if (!page || page.type !== 'page' || typeof page.url !== 'string') return false;
    try {
        return new URL(page.url).origin === GEMINI_ORIGIN;
    } catch (_) {
        return false;
    }
}

async function selectUniqueMatchedTarget(pages, matcherFn) {
    const geminiTargets = (Array.isArray(pages) ? pages : []).filter(isGeminiPageTarget);
    const matched = [];
    for (const page of geminiTargets) {
        if (await matcherFn(page)) {
            matched.push(page);
        }
    }
    if (matched.length !== 1) {
        throw new Error(`Owned Gemini page was not unique (matched=${matched.length})`);
    }
    return matched[0];
}

function parseAttributes(attrs = []) {
    const map = {};
    for (let i = 0; i + 1 < attrs.length; i += 2) {
        map[String(attrs[i]).toLowerCase()] = String(attrs[i + 1]);
    }
    return map;
}

const IMAGE_ACCEPT_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.gif',
    '.bmp',
    '.svg',
    '.heic',
    '.heif',
]);

const DOCUMENT_ACCEPT_EXTENSIONS = new Set([
    '.pdf',
    '.md',
    '.markdown',
    '.txt',
    '.doc',
    '.docx',
    '.csv',
    '.json',
    '.rtf',
    '.odt',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
]);

function isImageAcceptToken(token) {
    return token === 'image/*'
        || token.startsWith('image/')
        || IMAGE_ACCEPT_EXTENSIONS.has(token);
}

function isDocumentAcceptToken(token) {
    return token === '*/*'
        || token === 'application/*'
        || token === 'text/*'
        || (token.includes('/') && !token.startsWith('image/'))
        || DOCUMENT_ACCEPT_EXTENSIONS.has(token);
}

function inputAcceptsKind(acceptAttr, uploadKind) {
    const accept = String(acceptAttr || '').trim().toLowerCase();
    if (!accept) return true;
    const tokens = accept.split(',').map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 0) return true;
    if (uploadKind === 'image') {
        return tokens.some((t) => t === '*/*' || isImageAcceptToken(t));
    }
    return tokens.some((t) => isDocumentAcceptToken(t));
}

// Collect ALL `<input type="file">` inside composer subtree (excluding iframe contentDocument).
function collectAllComposerFileInputs(rootNode, out = []) {
    if (!rootNode || typeof rootNode !== 'object') return out;
    if (String(rootNode.nodeName || '').toUpperCase() === 'INPUT') {
        const attrs = parseAttributes(rootNode.attributes);
        if ((attrs.type || '').toLowerCase() === 'file' && typeof rootNode.backendNodeId === 'number') {
            out.push({ backendNodeId: rootNode.backendNodeId, accept: attrs.accept || '' });
        }
    }
    for (const child of rootNode.children || []) {
        collectAllComposerFileInputs(child, out);
    }
    for (const shadow of rootNode.shadowRoots || []) {
        collectAllComposerFileInputs(shadow, out);
    }
    return out;
}

function findScopedFileInputs(rootNode, uploadKind, out = []) {
    for (const item of collectAllComposerFileInputs(rootNode)) {
        if (inputAcceptsKind(item.accept, uploadKind)) {
            out.push(item);
        }
    }
    return out;
}

function isWithinContainerShadowPiercing(container, node, doc) {
    if (!container || !node || (doc && node.ownerDocument !== doc)) {
        return false;
    }
    let cur = node;
    let steps = 0;
    while (cur && steps < 128) {
        steps += 1;
        if (cur === container) return true;
        cur = cur.parentNode || cur.host || null;
    }
    return false;
}

function buildResolveComposerContextExpression(expectedToken) {
    const selectorsJson = JSON.stringify(GEMINI_COMPOSER_INPUT_SELECTORS);
    const originJson = JSON.stringify(GEMINI_ORIGIN);
    const tokenJson = JSON.stringify(expectedToken || '');
    return `(() => {
        if (window.location.origin !== ${originJson}) {
            throw new Error('Gemini upload origin mismatch');
        }
        if (${tokenJson} && window.__ask_bridge_upload_token !== ${tokenJson}) {
            throw new Error('Gemini upload ownership token mismatch');
        }
        const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && style.opacity !== '0'
                && rect.width > 0
                && rect.height > 0;
        };
        const rawMatches = [];
        const seen = new Set();
        for (const s of ${selectorsJson}) {
            for (const el of document.querySelectorAll(s)) {
                if (!seen.has(el) && isVisible(el)) {
                    seen.add(el);
                    rawMatches.push(el);
                }
            }
        }
        const inputs = rawMatches.filter((el) => !rawMatches.some((other) => other !== el && other.contains(el)));
        if (inputs.length !== 1) {
            throw new Error(inputs.length === 0 ? 'Gemini composer textbox unavailable' : 'Gemini composer textbox ambiguous');
        }
        const input = inputs[0];
        const container = input.closest('input-area-v2')
            || input.closest('[data-testid*="composer"]')
            || input.closest('rich-textarea')
            || input.closest('form')
            || input.parentElement;
        if (!container || container === document.body || container === document.documentElement) {
            throw new Error('Gemini composer container unbounded');
        }
        return container;
    })()`;
}

async function verifyAndResolveComposerContext(cdp, expectedToken) {
    const res = await cdp.call('Runtime.evaluate', {
        expression: buildResolveComposerContextExpression(expectedToken),
        returnByValue: false,
    });
    const objectId = res && res.result && res.result.objectId;
    if (!objectId) {
        const desc = (res && res.exceptionDetails && res.exceptionDetails.exception && res.exceptionDetails.exception.description)
            || 'Failed to resolve Gemini composer context objectId';
        throw new Error(desc);
    }
    const frameTree = await cdp.call('Page.getFrameTree');
    const mainFrameId = frameTree && frameTree.frameTree && frameTree.frameTree.frame && frameTree.frameTree.frame.id;
    if (!mainFrameId || typeof mainFrameId !== 'string') {
        throw new Error('Gemini mainFrameId unavailable');
    }
    return { objectId, mainFrameId };
}

function waitForChooserOrTimeout(waitMs, promise, timerFn = setTimeout, clearTimerFn = clearTimeout) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimerFn(timer)),
        new Promise((_, reject) => {
            timer = timerFn(() => reject(new Error('Timed out waiting for Gemini native fileChooserOpened')), waitMs);
        }),
    ]);
}

const BROWSER_SHADOW_CONTAINS_FN = `function isShadowWithin(container, node) {
    if (!container || !node || node.ownerDocument !== window.document) return false;
    let cur = node;
    let steps = 0;
    while (cur && steps < 128) {
        steps += 1;
        if (cur === container) return true;
        cur = cur.parentNode || cur.host || null;
    }
    return false;
}`;

async function validateChooserInputNode(cdp, event, mainFrameId, composerObjectId, uploadKind) {
    if (!event || event.frameId !== mainFrameId) {
        throw new Error('Gemini fileChooserOpened rejected: frameId mismatch');
    }
    if (!Number.isInteger(event.backendNodeId) || event.backendNodeId <= 0) {
        throw new Error('Gemini fileChooserOpened rejected: missing backendNodeId');
    }
    const desc = await cdp.call('DOM.describeNode', { backendNodeId: event.backendNodeId });
    const node = desc && desc.node;
    if (!node || String(node.nodeName || '').toUpperCase() !== 'INPUT') {
        throw new Error('Gemini fileChooserOpened rejected: target node is not INPUT');
    }
    const attrs = parseAttributes(node.attributes || []);
    if ((attrs.type || '').toLowerCase() !== 'file') {
        throw new Error('Gemini fileChooserOpened rejected: target input type is not file');
    }
    if (!inputAcceptsKind(attrs.accept || '', uploadKind)) {
        throw new Error('Gemini fileChooserOpened rejected: input accept does not match uploadKind');
    }
    const resolved = await cdp.call('DOM.resolveNode', { backendNodeId: event.backendNodeId });
    const inputObjectId = resolved && resolved.object && resolved.object.objectId;
    if (!inputObjectId) {
        throw new Error('Gemini fileChooserOpened rejected: DOM.resolveNode failed');
    }
    const scopeCheck = await cdp.call('Runtime.callFunctionOn', {
        objectId: composerObjectId,
        arguments: [{ objectId: inputObjectId }],
        functionDeclaration: `function(inputEl) {
            ${BROWSER_SHADOW_CONTAINS_FN}
            if (!inputEl || inputEl.ownerDocument !== window.document) {
                return { ok: false, reason: 'ownerDocument_mismatch' };
            }
            const inComposer = isShadowWithin(this, inputEl);
            const inOpenedMenu = Boolean(
                window.__ask_bridge_opened_menu_v1
                && isShadowWithin(window.__ask_bridge_opened_menu_v1, inputEl)
            );
            const matchedTriggeredPortal = Boolean(
                window.__ask_bridge_triggered_file_input
                && inputEl === window.__ask_bridge_triggered_file_input
            );
            if (!inComposer && !inOpenedMenu && !matchedTriggeredPortal) {
                return { ok: false, reason: 'outside_verified_composer_and_menu' };
            }
            return { ok: true };
        }`,
        returnByValue: true,
    });
    if (!scopeCheck || !scopeCheck.result || !scopeCheck.result.value || scopeCheck.result.value.ok !== true) {
        const reason = scopeCheck && scopeCheck.result && scopeCheck.result.value && scopeCheck.result.value.reason;
        throw new Error(`Gemini fileChooserOpened rejected: ${reason || 'scope_verification_failed'}`);
    }
}

async function filterConnectedDocumentInputs(cdp, composerObjectId, candidates) {
    const accepted = [];
    for (const candidate of candidates) {
        const resolved = await cdp.call('DOM.resolveNode', { backendNodeId: candidate.backendNodeId });
        const inputObjectId = resolved && resolved.object && resolved.object.objectId;
        if (!inputObjectId) continue;
        const check = await cdp.call('Runtime.callFunctionOn', {
            objectId: composerObjectId,
            arguments: [{ objectId: inputObjectId }],
            functionDeclaration: `function(inputEl) {
                ${BROWSER_SHADOW_CONTAINS_FN}
                return isShadowWithin(this, inputEl);
            }`,
            returnByValue: true,
        });
        if (check && check.result && check.result.value === true) {
            accepted.push(candidate);
        }
    }
    return accepted;
}

async function uploadToGeminiPage(cdp, filePath, uploadKind, options = {}) {
    const token = options.token || '';
    const timerFn = options.setTimeoutFn || setTimeout;
    const clearTimerFn = options.clearTimeoutFn || clearTimeout;
    const chooserWaitMs = Number.isFinite(options.chooserWaitMs) ? options.chooserWaitMs : GEMINI_CHOOSER_WAIT_MS;

    let unsubscribeChooser = () => {};
    let earlyChooserError = null;
    try {
        await cdp.call('Page.enable');
        await cdp.call('DOM.enable');
        const { objectId: composerObjectId, mainFrameId } = await verifyAndResolveComposerContext(cdp, token);

        let clickDispatched = false;
        let resolveChooser;
        let rejectChooser;
        const chooserPromise = new Promise((resolve, reject) => {
            resolveChooser = resolve;
            rejectChooser = reject;
        });
        chooserPromise.catch((err) => {
            earlyChooserError = err;
        });

        const handleChooserEvent = (event) => {
            if (!clickDispatched) {
                const err = new Error('Gemini fileChooserOpened rejected: fired before upload click dispatch');
                earlyChooserError = err;
                rejectChooser(err);
                return;
            }
            resolveChooser(event);
        };

        if (typeof cdp.on === 'function') {
            unsubscribeChooser = cdp.on('Page.fileChooserOpened', handleChooserEvent);
        } else if (typeof cdp.onceEvent === 'function') {
            let active = true;
            unsubscribeChooser = () => { active = false; };
            cdp.onceEvent('Page.fileChooserOpened').then((event) => {
                if (active) handleChooserEvent(event);
            }, () => {});
        }

        // 1. Distinguish "no persistent input in composer" from "wrong-type or ambiguous persistent input".
        const describedComposer = await cdp.call('DOM.describeNode', {
            objectId: composerObjectId,
            depth: -1,
            pierce: true,
        });
        const allCandidates = collectAllComposerFileInputs(describedComposer && describedComposer.node);
        const connectedAll = await filterConnectedDocumentInputs(cdp, composerObjectId, allCandidates);
        if (earlyChooserError) {
            throw earlyChooserError;
        }
        if (connectedAll.length > 0) {
            const matching = connectedAll.filter((c) => inputAcceptsKind(c.accept, uploadKind));
            if (matching.length === 0) {
                throw new Error('Persistent file input inside Gemini composer does not accept uploadKind');
            }
            if (matching.length > 1) {
                throw new Error('Ambiguous file input elements found inside Gemini composer');
            }
            await cdp.call('DOM.setFileInputFiles', {
                files: [filePath],
                backendNodeId: matching[0].backendNodeId,
            });
            return { mechanism: 'persistent_input', status: 'uploaded:scoped-dom-input' };
        }

        // 2. Native file chooser interception bound strictly to verified trigger + menu click dispatch.
        await cdp.call('Page.setInterceptFileChooserDialog', { enabled: true });

        if (typeof options.triggerFn === 'function') {
            clickDispatched = true;
            await options.triggerFn({ cdp, composerObjectId, mainFrameId });
        } else {
            const clickTrigger = await cdp.call('Runtime.callFunctionOn', {
                objectId: composerObjectId,
                functionDeclaration: `function() {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const s = window.getComputedStyle(el);
                        const r = el.getBoundingClientRect();
                        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
                    };
                    const buttons = Array.from(this.querySelectorAll('button, [role="button"]')).filter(isVisible);
                    const primaryMatches = buttons.filter((el) => /add\\s*files?|upload|新增檔案|上傳檔案|上傳與工具|加入檔案|新增圖片|attach/i.test([el.getAttribute('aria-label'), el.textContent, el.getAttribute('title')].filter(Boolean).join(' ')));
                    const fallbackMatches = primaryMatches.length > 0
                        ? primaryMatches
                        : buttons.filter((el) => /add|plus|\\+/i.test([el.getAttribute('aria-label'), el.textContent, el.getAttribute('mattooltip')].filter(Boolean).join(' ')));
                    if (fallbackMatches.length !== 1) {
                        return { clicked: false, reason: fallbackMatches.length === 0 ? 'upload_trigger_not_found' : 'ambiguous_upload_triggers' };
                    }
                    const uploadBtn = fallbackMatches[0];
                    const menuSel = '[role="menu"], [role="listbox"], .mat-mdc-menu-panel, .cdk-overlay-pane';
                    const preVisible = new Set(Array.from(document.querySelectorAll(menuSel)).filter(isVisible));
                    const readAriaRefs = (el) => Array.from(new Set(
                        [el && el.getAttribute('aria-controls'), el && el.getAttribute('aria-owns')]
                            .filter(Boolean)
                            .flatMap((raw) => String(raw).trim().split(/\\s+/).filter(Boolean))
                    ));
                    window.__ask_bridge_pre_menus_v1 = preVisible;
                    window.__ask_bridge_upload_btn_v1 = uploadBtn;
                    window.__ask_bridge_trigger_aria_refs_v1 = readAriaRefs(uploadBtn);
                    window.__ask_bridge_opened_menu_v1 = null;
                    window.__ask_bridge_triggered_file_input = null;
                    uploadBtn.click();
                    return { clicked: true };
                }`,
                returnByValue: true,
            });
            if (!clickTrigger || !clickTrigger.result || !clickTrigger.result.value || clickTrigger.result.value.clicked !== true) {
                throw new Error('Gemini composer upload trigger not found');
            }

            await new Promise((r) => timerFn(r, 350));
            if (earlyChooserError) {
                throw earlyChooserError;
            }

            clickDispatched = true;
            const step2Res = await cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const s = window.getComputedStyle(el);
                        const r = el.getBoundingClientRect();
                        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
                    };
                    const pre = window.__ask_bridge_pre_menus_v1 instanceof Set ? window.__ask_bridge_pre_menus_v1 : new Set();
                    const readAriaRefs = (el) => Array.from(new Set(
                        [el && el.getAttribute('aria-controls'), el && el.getAttribute('aria-owns')]
                            .filter(Boolean)
                            .flatMap((raw) => String(raw).trim().split(/\\s+/).filter(Boolean))
                    ));
                    const storedAriaRefs = Array.isArray(window.__ask_bridge_trigger_aria_refs_v1) ? window.__ask_bridge_trigger_aria_refs_v1 : [];
                    const ariaRefs = Array.from(new Set([...storedAriaRefs, ...readAriaRefs(window.__ask_bridge_upload_btn_v1)]));
                    const isMenuLike = (el) => Boolean(el) && (
                        el.matches('[role="menu"], [role="listbox"], .mat-mdc-menu-panel, .cdk-overlay-pane')
                        || Boolean(el.querySelector('[role="menuitem"], [role="option"]'))
                    );
                    const ariaMenus = [];
                    const seenAria = new Set();
                    for (const refId of ariaRefs) {
                        const target = document.getElementById(refId);
                        if (target && !seenAria.has(target) && isVisible(target) && isMenuLike(target)) {
                            seenAria.add(target);
                            ariaMenus.push(target);
                        }
                    }
                    let menuContainer = null;
                    if (ariaMenus.length > 1) {
                        return { clicked: false, reason: 'ambiguous_aria_menu_targets' };
                    }
                    if (ariaMenus.length === 1) {
                        menuContainer = ariaMenus[0];
                    } else {
                        const menuSel = '[role="menu"], [role="listbox"], .mat-mdc-menu-panel, .cdk-overlay-pane';
                        const rawNewlyVisible = Array.from(document.querySelectorAll(menuSel)).filter((el) => isVisible(el) && !pre.has(el));
                        const newlyVisible = rawNewlyVisible.filter((el) => !rawNewlyVisible.some((other) => other !== el && typeof el.contains === 'function' && el.contains(other)));
                        if (newlyVisible.length === 1) {
                            menuContainer = newlyVisible[0];
                        }
                    }
                    if (!menuContainer) {
                        return { clicked: false, reason: 'opened_menu_not_found' };
                    }
                    window.__ask_bridge_opened_menu_v1 = menuContainer;
                    const itemSel = '[role="menuitem"], [role="option"], [role="button"], button';
                    const matchingItems = Array.from(menuContainer.querySelectorAll(itemSel)).filter(isVisible).filter((el) =>
                        /upload\\s*from\\s*computer|upload\\s*files?|上傳檔案|從電腦上傳|上傳圖片|add\\s*images?/i.test([el.getAttribute('aria-label'), el.textContent].filter(Boolean).join(' '))
                    );
                    if (matchingItems.length !== 1) {
                        return { clicked: false, reason: matchingItems.length === 0 ? 'menu_upload_item_not_found' : 'ambiguous_menu_upload_items' };
                    }
                    const uploadItem = matchingItems[0];
                    const origClick = HTMLInputElement.prototype.click;
                    try {
                        HTMLInputElement.prototype.click = function() {
                            if (this && this.tagName === 'INPUT' && String(this.type || '').toLowerCase() === 'file') {
                                window.__ask_bridge_triggered_file_input = this;
                            }
                            return origClick.apply(this, arguments);
                        };
                        uploadItem.click();
                    } finally {
                        HTMLInputElement.prototype.click = origClick;
                    }
                    return { clicked: true };
                })()`,
                returnByValue: true,
            });
            const step2Val = step2Res && step2Res.result && step2Res.result.value;
            const step2Ok = step2Val === true || (step2Val && typeof step2Val === 'object' && step2Val.clicked === true);
            if (!step2Ok) {
                clickDispatched = false;
                throw new Error(`Gemini menu upload item click failed: ${(step2Val && step2Val.reason) || 'not_clicked'}`);
            }
        }

        if (earlyChooserError) {
            throw earlyChooserError;
        }
        const chooserEvent = await waitForChooserOrTimeout(chooserWaitMs, chooserPromise, timerFn, clearTimerFn);
        await validateChooserInputNode(cdp, chooserEvent, mainFrameId, composerObjectId, uploadKind);
        await cdp.call('DOM.setFileInputFiles', {
            files: [filePath],
            backendNodeId: chooserEvent.backendNodeId,
        });
        return { mechanism: 'dynamic_file_chooser', status: 'uploaded:cdp-chooser' };
    } finally {
        unsubscribeChooser();
        try { await cdp.call('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (_) {}
        try {
            await cdp.call('Runtime.evaluate', {
                expression: 'delete window.__ask_bridge_upload_token; delete window.__ask_bridge_pre_menus_v1; delete window.__ask_bridge_upload_btn_v1; delete window.__ask_bridge_trigger_aria_refs_v1; delete window.__ask_bridge_opened_menu_v1; delete window.__ask_bridge_triggered_file_input',
            });
        } catch (_) {}
    }
}

async function run(deps = {}) {
    const token = deps.token ?? tokenArg;
    const filePath = deps.filePath ?? filePathArg;
    const uploadKind = deps.uploadKind ?? uploadKindArg;
    const fetchImpl = deps.fetch || fetch;
    const WebSocketCtor = deps.WebSocketCtor || WebSocket;
    const timerFn = deps.setTimeoutFn || setTimeout;
    const clearTimerFn = deps.clearTimeoutFn || clearTimeout;
    const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : GEMINI_UPLOAD_TIMEOUT_MS;
    const devToolsUrl = deps.devToolsUrl || 'http://127.0.0.1:9223/json/list';

    if (!token || !filePath || !['image', 'document'].includes(uploadKind)) {
        throw new Error('Invalid Gemini upload arguments');
    }

    let deadlineTimer = null;
    const deadlinePromise = new Promise((_, reject) => {
        deadlineTimer = timerFn(() => reject(new Error('Gemini upload timed out')), timeoutMs);
    });

    const execute = async () => {
        const pages = await (await fetchImpl(devToolsUrl)).json();
        const sessions = [];
        try {
            const matched = [];
            for (const page of (Array.isArray(pages) ? pages : []).filter(isGeminiPageTarget)) {
                const ws = new WebSocketCtor(page.webSocketDebuggerUrl);
                const cdp = new CdpSession(ws);
                sessions.push(cdp);
                try {
                    await new Promise((resolve, reject) => {
                        ws.addEventListener('open', resolve, { once: true });
                        ws.addEventListener('error', reject, { once: true });
                    });
                    const marker = await cdp.call('Runtime.evaluate', {
                        expression: 'window.__ask_bridge_upload_token',
                        returnByValue: true,
                    });
                    if (marker && marker.result && marker.result.value === token) {
                        matched.push({ page, cdp });
                    }
                } catch (_) {}
            }
            if (matched.length !== 1) {
                throw new Error(`Owned Gemini target was not unique (matched=${matched.length})`);
            }
            const res = await uploadToGeminiPage(matched[0].cdp, filePath, uploadKind, {
                ...deps,
                token,
            });
            return res.status;
        } finally {
            for (const cdp of sessions) cdp.close();
        }
    };

    try {
        return await Promise.race([execute(), deadlinePromise]);
    } finally {
        clearTimerFn(deadlineTimer);
    }
}

module.exports = {
    GEMINI_ORIGIN,
    GEMINI_COMPOSER_INPUT_SELECTORS,
    parseAttributes,
    inputAcceptsKind,
    collectAllComposerFileInputs,
    findScopedFileInputs,
    isWithinContainerShadowPiercing,
    buildResolveComposerContextExpression,
    verifyAndResolveComposerContext,
    validateChooserInputNode,
    waitForChooserOrTimeout,
    isGeminiPageTarget,
    selectUniqueMatchedTarget,
    uploadToGeminiPage,
    run,
};

if (process.env.ASK_BRIDGE_UPLOAD_NO_AUTORUN !== '1') {
    run().then((status) => {
        process.stdout.write(`${status}\n`);
        process.exit(0);
    }).catch((error) => {
        console.error(error && error.message ? error.message : 'Gemini CDP upload failed');
        process.exit(1);
    });
}
