// Positive login-gate probe for Gemini.
// Loaded in browser `evaluate_script` via Rust `include_str!("gemini_login_probe.js")`
// and directly unit-tested in Node with simulated DOM ticks.

const GEMINI_AUTH_CONTROL_RE = /^(?:sign\s*in|log\s*in|登入|登錄|登录)(?:\s+(?:to\s+(?:google|gemini)|into\s+google))?$/i;

function geminiIsAuthControl(el, isVisibleFn) {
    if (!el || !isVisibleFn(el)) return false;
    if (typeof el.getAttribute === 'function') {
        const href = String(el.getAttribute('href') || '');
        if (/accounts\.google\.com\/ServiceLogin/i.test(href)) {
            return true;
        }
    }
    const fields = [
        typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : '',
        typeof el.getAttribute === 'function' ? el.getAttribute('title') : '',
        el.innerText,
        el.textContent,
    ];
    return fields.some((field) => {
        const trimmed = String(field || '').trim();
        return Boolean(trimmed) && GEMINI_AUTH_CONTROL_RE.test(trimmed);
    });
}

function readGeminiLoginSignals(doc, loc, isVisibleFn) {
    const firstVisible = (selectors) => {
        for (const selector of selectors) {
            const match = Array.from(doc.querySelectorAll(selector))
                .find((candidate) => isVisibleFn(candidate));
            if (match) return match;
        }
        return null;
    };
    const composer = firstVisible([
        'div[role="textbox"][aria-label*="Gemini"]',
        'rich-textarea [contenteditable="true"]',
        '.ql-editor[contenteditable="true"]',
    ]);
    const account = firstVisible([
        'a[href*="accounts.google.com/SignOutOptions"]',
        '[aria-label*="Google 帳戶"]',
        '[aria-label*="Google Account"]',
    ]);
    const signIn = Array.from(doc.querySelectorAll('a, button, [role="button"]'))
        .some((el) => geminiIsAuthControl(el, isVisibleFn));
    const pathname = String((loc && loc.pathname) || '');
    const hostname = String((loc && loc.hostname) || '');
    const authPath = /\/(auth|login|signin|signup)(\/|$)/i.test(pathname) || hostname === 'accounts.google.com';
    return {
        account: Boolean(account && isVisibleFn(account)),
        auth_control: Boolean(signIn),
        auth_path: Boolean(authPath),
        composer: Boolean(composer && isVisibleFn(composer)),
    };
}

async function probeGeminiLoginStability(options = {}) {
    const readSignals = options.readSignals || (() => {
        const doc = options.doc || (typeof document !== 'undefined' ? document : null);
        const loc = options.loc || (typeof window !== 'undefined' ? window.location : {});
        const isVisibleFn = options.isVisible || ((el) => {
            if (!el) return false;
            if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' && typeof el.getBoundingClientRect === 'function') {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && style.opacity !== '0'
                    && rect.width > 0
                    && rect.height > 0;
            }
            return true;
        });
        return readGeminiLoginSignals(doc, loc, isVisibleFn);
    });
    const now = options.now || (() => Date.now());
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 150;
    const minPositiveWindowMs = Number.isFinite(options.minPositiveWindowMs) ? options.minPositiveWindowMs : 750;
    const minElapsedMs = Number.isFinite(options.minElapsedMs) ? options.minElapsedMs : 800;
    const maxWaitMs = Number.isFinite(options.maxWaitMs) ? options.maxWaitMs : 4000;

    const isPositive = (s) => Boolean(s && s.account && s.composer && !s.auth_control && !s.auth_path);

    let signals = readSignals();
    let signature = JSON.stringify(signals);
    const startedAt = now();
    let stableSince = startedAt;
    let positiveSince = isPositive(signals) ? startedAt : null;
    let stable = Boolean(signals.auth_path);
    const earliestLoggedOutDecision = startedAt + 1200;
    const deadline = startedAt + maxWaitMs;

    while (!stable && now() < deadline) {
        await sleep(pollIntervalMs);
        const tickNow = now();
        const nextSignals = readSignals();
        const nextSignature = JSON.stringify(nextSignals);
        if (nextSignature !== signature) {
            signature = nextSignature;
            stableSince = tickNow;
        }
        signals = nextSignals;

        if (signals.auth_path) {
            stable = true;
            break;
        }
        if (isPositive(signals)) {
            if (positiveSince === null) {
                positiveSince = tickNow;
            }
            if ((tickNow - positiveSince) >= minPositiveWindowMs && tickNow >= startedAt + minElapsedMs) {
                stable = true;
                break;
            }
        } else {
            positiveSince = null;
            if (tickNow >= earliestLoggedOutDecision && (tickNow - stableSince) >= 500) {
                stable = true;
                break;
            }
        }
    }

    return { ...signals, stable };
}

if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
        GEMINI_AUTH_CONTROL_RE,
        geminiIsAuthControl,
        readGeminiLoginSignals,
        probeGeminiLoginStability,
    };
}
