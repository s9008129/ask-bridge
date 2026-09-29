// Upload to the exact page marked by ask-bridge. Never infer ownership from tab order.
const [token, filePath, kind] = process.argv.slice(1);

async function call(ws, method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e9);
        const onMessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.id !== id) return;
            ws.removeEventListener('message', onMessage);
            if (message.error) reject(new Error(message.error.message));
            else resolve(message.result);
        };
        ws.addEventListener('message', onMessage);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

const cdpFor = (ws) => ({ call: (method, params = {}) => call(ws, method, params) });

const FILE_INPUT_SELECTOR = {
    document: 'input[type="file"][aria-label="附加檔案"], input[type="file"]:not([accept])',
    image: 'input[type="file"][aria-label="附加相片或影片"], input[type="file"][accept*="image/"]',
};
const MENU_BUTTON_LABELS = ['新增檔案和更多內容', 'Add files and more'];
const MENU_OPEN_LABELS = ['新增相片與檔案', 'Add photos & files'];

async function findFileInputNodeId(cdp, kind) {
    const doc = await cdp.call('DOM.getDocument');
    const input = await cdp.call('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: FILE_INPUT_SELECTOR[kind],
    });
    return input.nodeId;
}

async function isMenuOpen(cdp) {
    const labels = JSON.stringify(MENU_OPEN_LABELS);
    const check = await cdp.call('Runtime.evaluate', {
        expression: `Array.from(document.querySelectorAll('button')).some(el => ${labels}.some(label => (el.innerText || '').includes(label)))`,
        returnByValue: true,
    });
    return check.result?.value === true;
}

// Clicking the composer's attachment trigger toggles a popover.  After the
// first native upload ChatGPT can leave the trigger in a "phantom open" state
// (aria-expanded="true" with no rendered popover, observed 2026-09-29), so the
// next single click closes instead of opens and can never recover by itself.
// Retry until a *visible* menu is present; every attempt either opens the menu
// or burns one phantom-open toggle.
async function ensureMenuOpen(cdp, { maxClicks = 4, attempts = 12, pollMs = 250 } = {}) {
    const labels = JSON.stringify(MENU_BUTTON_LABELS);
    for (let click = 0; click < maxClicks; click++) {
        if (await isMenuOpen(cdp)) return;
        const clicked = await cdp.call('Runtime.evaluate', {
            expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find(el => ${labels}.includes(el.getAttribute('aria-label'))); if (!button) return false; button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', isPrimary: true })); button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', isPrimary: true })); button.click(); return true; })()`,
            returnByValue: true,
        });
        if (clicked.result?.value !== true) throw new Error('Attachment menu unavailable');
        for (let attempt = 0; attempt < attempts; attempt++) {
            await new Promise(resolve => setTimeout(resolve, pollMs));
            if (await isMenuOpen(cdp)) return;
        }
    }
    throw new Error('Attachment menu did not open');
}

// The composer always owns hidden file inputs, so set files directly and leave
// the menu untouched; the menu click is only a fallback for a composer whose
// input is not mounted yet.  Opening the menu before the first upload (the
// pre-2026-09-29 path) is what desynchronised the trigger for every following
// file and made ask-bridge report ATTACHMENT_VERIFICATION_FAILED.
async function resolveFileInputNodeId(cdp, kind, menuOptions) {
    const direct = await findFileInputNodeId(cdp, kind);
    if (direct) return direct;
    await ensureMenuOpen(cdp, menuOptions);
    const inputNodeId = await findFileInputNodeId(cdp, kind);
    if (!inputNodeId) throw new Error('File input unavailable');
    return inputNodeId;
}

async function run() {
    const deadline = setTimeout(() => process.exit(1), 30000);
    if (!token || !filePath || !['image', 'document'].includes(kind)) throw new Error('Invalid upload request');
    const pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
    let matches = 0;
    for (const page of pages) {
        if (page.type !== 'page' || !page.url.startsWith('https://chatgpt.com/')) continue;
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', reject, { once: true });
        });
        try {
            const marker = await call(ws, 'Runtime.evaluate', {
                expression: 'window.__ask_bridge_upload_token', returnByValue: true,
            });
            if (marker.result?.value !== token) continue;
            matches++;
            const cdp = cdpFor(ws);
            const inputNodeId = await resolveFileInputNodeId(cdp, kind);
            await call(ws, 'DOM.setFileInputFiles', { nodeId: inputNodeId, files: [filePath] });
            const fileName = filePath.split(/[\\/]/).pop();
            const dot = fileName.lastIndexOf('.');
            const stem = dot < 0 ? fileName : fileName.slice(0, dot);
            let appeared = false;
            for (let attempt = 0; attempt < 80; attempt++) {
                const check = await call(ws, 'Runtime.evaluate', {
                    expression: `Array.from(document.querySelectorAll('[class*="group/composer-attachment"]')).some(el => (el.innerText || el.getAttribute('aria-label') || '').includes(${JSON.stringify(stem)}))`,
                    returnByValue: true,
                });
                if (check.result?.value === true) { appeared = true; break; }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            if (!appeared) throw new Error('Uploaded file did not appear in composer');
            await call(ws, 'Runtime.evaluate', { expression: 'delete window.__ask_bridge_upload_token' });
        } finally {
            ws.close();
        }
    }
    if (matches !== 1) throw new Error('Owned ChatGPT page was not unique');
    clearTimeout(deadline);
}

module.exports = { ensureMenuOpen, findFileInputNodeId, isMenuOpen, resolveFileInputNodeId, FILE_INPUT_SELECTOR };

if (process.env.ASK_BRIDGE_UPLOAD_NO_AUTORUN !== '1') {
    run().catch((error) => {
        const known = ['Invalid upload request', 'Attachment menu unavailable', 'Attachment menu did not open', 'File input unavailable', 'Uploaded file did not appear in composer', 'Owned ChatGPT page was not unique'];
        console.error(known.find(message => error.message === message) || 'CDP upload operation failed');
        process.exit(1);
    });
}
