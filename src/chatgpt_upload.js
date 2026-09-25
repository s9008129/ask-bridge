// Upload to the exact page marked by ask-bridge. Never infer ownership from tab order.
const [token, filePath, kind] = process.argv.slice(1);
const deadline = setTimeout(() => process.exit(1), 30000);

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

async function run() {
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
            const isMenuOpen = async () => {
                const check = await call(ws, 'Runtime.evaluate', {
                    expression: `Array.from(document.querySelectorAll('button')).some(el => ['新增相片與檔案', 'Add photos & files'].some(label => (el.innerText || '').includes(label)))`,
                    returnByValue: true,
                });
                return check.result?.value === true;
            };
            let menuReady = await isMenuOpen();
            if (!menuReady) {
                const clicked = await call(ws, 'Runtime.evaluate', {
                    expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find(el => ['新增檔案和更多內容', 'Add files and more'].includes(el.getAttribute('aria-label'))); if (!button) return false; button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', isPrimary: true })); button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', isPrimary: true })); button.click(); return true; })()`,
                    returnByValue: true,
                });
                if (clicked.result?.value !== true) throw new Error('Attachment menu unavailable');
                for (let attempt = 0; attempt < 20; attempt++) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    if (await isMenuOpen()) { menuReady = true; break; }
                }
            }
            if (!menuReady) throw new Error('Attachment menu did not open');
            const doc = await call(ws, 'DOM.getDocument');
            const selector = kind === 'document'
                ? 'input[type="file"][aria-label="附加檔案"], input[type="file"]:not([accept])'
                : 'input[type="file"][aria-label="附加相片或影片"], input[type="file"][accept*="image/"]';
            const input = await call(ws, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector });
            if (!input.nodeId) throw new Error('File input unavailable');
            await call(ws, 'DOM.setFileInputFiles', { nodeId: input.nodeId, files: [filePath] });
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

run().catch((error) => {
    const known = ['Invalid upload request', 'Attachment menu unavailable', 'Attachment menu did not open', 'File input unavailable', 'Uploaded file did not appear in composer', 'Owned ChatGPT page was not unique'];
    console.error(known.find(message => error.message === message) || 'CDP upload operation failed');
    process.exit(1);
});
