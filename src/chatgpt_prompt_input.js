// Insert prompt text into the uniquely owned ChatGPT tab via Chrome's native
// input event. Prompt bytes arrive on stdin so they are not exposed in argv.
const [token] = process.argv.slice(1);
const input = [];
const deadline = setTimeout(() => process.exit(1), 30000);

async function call(ws, method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e9);
        const onMessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.id !== id) return;
            ws.removeEventListener('message', onMessage);
            if (message.error) reject(new Error('CDP command failed'));
            else resolve(message.result);
        };
        ws.addEventListener('message', onMessage);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

async function open(ws) {
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });
}

async function evaluate(ws, expression) {
    const result = await call(ws, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error('Page evaluation failed');
    return result.result?.value;
}

async function findOwnedPage() {
    const pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
    const matches = [];
    for (const page of pages) {
        if (page.type !== 'page' || !page.url.startsWith('https://chatgpt.com/')) continue;
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        try {
            await open(ws);
            const marker = await evaluate(ws, 'window.__ask_bridge_prompt_input_token');
            if (marker === token) matches.push({ page, ws });
            else ws.close();
        } catch (_) {
            ws.close();
        }
    }
    if (matches.length !== 1) {
        for (const match of matches) match.ws.close();
        throw new Error('Owned ChatGPT page was not unique');
    }
    return matches[0];
}

async function run() {
    if (!token) throw new Error('Invalid prompt input request');
    for await (const chunk of process.stdin) input.push(chunk);
    const prompt = Buffer.concat(input).toString('utf8');
    if (!prompt.trim()) throw new Error('Prompt text was empty');

    const { ws } = await findOwnedPage();
    try {
        const ready = await evaluate(ws, `(() => {
            const selectors = ['#prompt-textarea', '[data-testid="composer-text-input"]', '[role="textbox"][contenteditable="true"]'];
            const visible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            };
            const composer = selectors.map((selector) => document.querySelector(selector)).find(visible);
            if (!composer) return false;
            composer.focus();
            try {
                const range = document.createRange();
                range.selectNodeContents(composer);
                range.collapse(false);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            } catch (_) {}
            return document.activeElement === composer;
        })()`);
        if (ready !== true) throw new Error('ChatGPT composer unavailable');

        await call(ws, 'Input.insertText', { text: prompt });
        await evaluate(ws, 'delete window.__ask_bridge_prompt_input_token');
        process.stdout.write('prompt-inserted\n');
    } finally {
        ws.close();
    }
    clearTimeout(deadline);
}

run().catch((error) => {
    const known = [
        'Invalid prompt input request',
        'Prompt text was empty',
        'Owned ChatGPT page was not unique',
        'ChatGPT composer unavailable',
    ];
    console.error(known.find((message) => error.message === message) || 'CDP prompt input failed');
    process.exit(1);
});
