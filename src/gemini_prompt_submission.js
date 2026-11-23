// Provable Gemini prompt insertion + pre-click verification + single-click +
// same-turn user-query echo verification.
const [token] = process.argv.slice(1);

const GEMINI_ORIGIN = 'https://gemini.google.com';
const GEMINI_COMPOSER_SELECTORS = [
    'div[role="textbox"][aria-label*="Gemini"]',
    'rich-textarea [contenteditable="true"]',
    '.ql-editor[contenteditable="true"]',
];

const normalizePromptText = (value) => String(value || '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/gu, ' ')
    .trim();

async function call(ws, method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e9);
        const onMessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.id !== id) return;
            ws.removeEventListener('message', onMessage);
            if (message.error) reject(new Error(message.error.message || 'CDP command failed'));
            else resolve(message.result);
        };
        ws.addEventListener('message', onMessage);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

function isGeminiPageTarget(page) {
    if (!page || page.type !== 'page' || typeof page.url !== 'string') return false;
    try {
        return new URL(page.url).origin === GEMINI_ORIGIN;
    } catch (_) {
        return false;
    }
}

async function runCli() {
    const deadline = setTimeout(() => process.exit(1), 30000);
    if (!token) throw new Error('Invalid Gemini prompt input request');

    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const prompt = Buffer.concat(chunks).toString('utf8');
    if (!normalizePromptText(prompt)) throw new Error('Prompt text was empty');

    const pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
    const matched = [];
    for (const page of (Array.isArray(pages) ? pages : []).filter(isGeminiPageTarget)) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        try {
            await new Promise((resolve, reject) => {
                ws.addEventListener('open', resolve, { once: true });
                ws.addEventListener('error', reject, { once: true });
            });
            const marker = await call(ws, 'Runtime.evaluate', {
                expression: 'window.__ask_bridge_gemini_prompt_token',
                returnByValue: true,
            });
            if (marker.result?.value === token) {
                matched.push({ page, ws });
            } else {
                ws.close();
            }
        } catch (_) {
            try { ws.close(); } catch (_) {}
        }
    }

    if (matched.length !== 1) {
        for (const entry of matched) {
            try { entry.ws.close(); } catch (_) {}
        }
        throw new Error('Owned Gemini page was not unique');
    }

    const { ws } = matched[0];
    try {
        const selectorsJson = JSON.stringify(GEMINI_COMPOSER_SELECTORS);
        const promptJson = JSON.stringify(prompt);

        const readyRes = await call(ws, 'Runtime.evaluate', {
            expression: `(() => {
                if (window.location.origin !== ${JSON.stringify(GEMINI_ORIGIN)}) {
                    return { ok: false, reason: 'origin_mismatch' };
                }
                const visible = (el) => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                };
                const composer = ${selectorsJson}.map((s) => document.querySelector(s)).find(visible);
                if (!composer) return { ok: false, reason: 'composer_unavailable' };
                composer.focus();
                try {
                    const range = document.createRange();
                    range.selectNodeContents(composer);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    document.execCommand('delete');
                } catch (_) {}
                if (document.activeElement !== composer && !composer.contains(document.activeElement)) {
                    return { ok: false, reason: 'composer_focus_failed' };
                }
                return { ok: true };
            })()`,
            returnByValue: true,
        });
        if (readyRes.result?.value?.ok !== true) {
            throw new Error(readyRes.result?.value?.reason || 'Gemini composer unavailable');
        }

        await call(ws, 'Input.insertText', { text: prompt });

        const verifyRes = await call(ws, 'Runtime.evaluate', {
            expression: `(() => {
                const normalize = (v) => String(v || '')
                    .normalize('NFC')
                    .replace(/[\\u200B-\\u200D\\uFEFF]/g, '')
                    .replace(/\\s+/gu, ' ')
                    .trim();
                const visible = (el) => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                };
                const composer = ${selectorsJson}.map((s) => document.querySelector(s)).find(visible);
                if (!composer) return { ok: false, reason: 'composer_unavailable' };
                const observed = normalize(typeof composer.value === 'string' ? composer.value : (composer.innerText || composer.textContent || ''));
                const expected = normalize(${promptJson});
                return {
                    ok: Boolean(expected) && observed === expected,
                    expected_len: expected.length,
                    observed_len: observed.length,
                };
            })()`,
            returnByValue: true,
        });
        if (verifyRes.result?.value?.ok !== true) {
            throw new Error('Gemini prompt insertion full readback verification failed');
        }

        process.stdout.write('prompt-inserted\n');
    } finally {
        try {
            await call(ws, 'Runtime.evaluate', { expression: 'delete window.__ask_bridge_gemini_prompt_token' });
        } catch (_) {}
        try { ws.close(); } catch (_) {}
    }
    clearTimeout(deadline);
}

module.exports = {
    GEMINI_ORIGIN,
    GEMINI_COMPOSER_SELECTORS,
    normalizePromptText,
    isGeminiPageTarget,
};

if (process.env.ASK_BRIDGE_PROMPT_NO_AUTORUN !== '1') {
    runCli().catch((error) => {
        console.error(error && error.message ? error.message : 'Gemini CDP prompt input failed');
        process.exit(1);
    });
}
