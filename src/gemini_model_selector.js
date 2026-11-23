// Shared Gemini mode menu selector & readback verification helper.
// Used directly via Rust `include_str!("gemini_model_selector.js")` in `switch_model`
// and exported for Node unit testing.

function normalizeGeminiModeLabel(value) {
    return String(value || '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/^(?:已選取|currently\s*selected|selected)\s*/i, '')
        .replace(/\s*(?:已選取|currently\s*selected|selected)$/i, '')
        .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function defaultVisibleCheck(el) {
    if (!el) return false;
    if (typeof el.hidden === 'boolean' && el.hidden) return false;
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
}

function isGeminiModeItemLockedOrDisabled(el) {
    if (!el) return true;
    if (el.disabled || (typeof el.hasAttribute === 'function' && el.hasAttribute('disabled'))) {
        return true;
    }
    if (typeof el.getAttribute === 'function') {
        if (el.getAttribute('aria-disabled') === 'true') return true;
        if (el.getAttribute('data-locked') === 'true') return true;
    }
    const ariaLabel = typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : '';
    const fullText = [el.innerText, el.textContent, ariaLabel].filter(Boolean).join(' ');
    const hasLockIcon = typeof el.querySelector === 'function'
        && Boolean(el.querySelector('[aria-label*="lock" i], [data-icon*="lock" i], mat-icon'));
    return /\bupgrade\b|升級|解鎖|locked/i.test(fullText) && hasLockIcon;
}

function geminiModeItemLabel(el) {
    if (!el) return '';
    const ariaLabel = typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : '';
    return ((String(el.innerText || el.textContent || ariaLabel || '').split('\n')[0]) || '').trim();
}

function findGeminiModePickerButton(doc, isVisible) {
    const buttons = Array.from(doc.querySelectorAll('button')).filter(isVisible);
    return buttons.find((button) => {
        const ariaLabel = typeof button.getAttribute === 'function' ? button.getAttribute('aria-label') : '';
        return /模式挑選器|model picker|mode picker/i.test([ariaLabel, button.textContent].filter(Boolean).join(' '));
    }) || null;
}

function visibleGeminiModeMenuItems(doc, isVisible) {
    return Array.from(doc.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')).filter(isVisible);
}

async function selectGeminiMode(targetModelRaw, options = {}) {
    const doc = options.doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return 'error: document unavailable';
    const isVisible = options.isVisible || defaultVisibleCheck;
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const closeWaitMs = Number.isFinite(options.closeWaitMs) ? options.closeWaitMs : 2000;
    const openWaitMs = Number.isFinite(options.openWaitMs) ? options.openWaitMs : 1500;
    const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 50;
    const dispatchEscape = options.dispatchEscape || (() => {
        if (typeof KeyboardEvent !== 'undefined' && typeof doc.dispatchEvent === 'function') {
            doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        }
    });

    const target = normalizeGeminiModeLabel(targetModelRaw);
    if (!target) return 'error: empty target';

    dispatchEscape();
    await sleep(250);

    const initialButton = findGeminiModePickerButton(doc, isVisible);
    if (!initialButton) return 'error: Gemini mode picker not found';

    initialButton.click();

    let items = [];
    const openDeadline = Date.now() + openWaitMs;
    do {
        await sleep(pollIntervalMs);
        items = visibleGeminiModeMenuItems(doc, isVisible);
        if (items.length > 0) break;
    } while (Date.now() < openDeadline);

    const matches = items.filter((item) => normalizeGeminiModeLabel(geminiModeItemLabel(item)) === target);
    if (matches.length === 0) {
        dispatchEscape();
        return 'error: model not found in menu';
    }
    if (matches.length > 1) {
        dispatchEscape();
        return 'error: ambiguous model match in menu';
    }

    const chosen = matches[0];
    if (isGeminiModeItemLockedOrDisabled(chosen)) {
        dispatchEscape();
        return 'error: matched model is locked or disabled';
    }

    chosen.click();

    // Poll until menu closes (up to 2000ms) instead of relying on a single fixed sleep.
    let menuClosed = false;
    const closeDeadline = Date.now() + closeWaitMs;
    while (Date.now() <= closeDeadline) {
        if (visibleGeminiModeMenuItems(doc, isVisible).length === 0) {
            menuClosed = true;
            break;
        }
        await sleep(pollIntervalMs);
    }
    if (!menuClosed) {
        dispatchEscape();
        return 'error: Gemini model menu failed to close after selection';
    }

    await sleep(150);

    // Re-query the mode picker button from live DOM rather than reading a stale node reference.
    const reboundButton = findGeminiModePickerButton(doc, isVisible);
    if (!reboundButton) {
        return 'error: Gemini model selection readback mismatch';
    }

    // Exact match only (no `.includes(target)` substring acceptance).
    const reboundLabel = String(reboundButton.innerText || reboundButton.textContent || '').trim();
    if (reboundLabel && normalizeGeminiModeLabel(reboundLabel) === target) {
        return 'success:gemini_mode_menu_v1';
    }

    // Reopen menu to verify checked/selected state cleanly with no conflicting checked item.
    reboundButton.click();
    let reopened = [];
    const reopenDeadline = Date.now() + openWaitMs;
    do {
        await sleep(pollIntervalMs);
        reopened = visibleGeminiModeMenuItems(doc, isVisible);
        if (reopened.length > 0) break;
    } while (Date.now() < reopenDeadline);

    const isItemChecked = (item) => (
        typeof item.getAttribute === 'function'
        && (item.getAttribute('aria-checked') === 'true' || item.getAttribute('aria-selected') === 'true')
    );

    const allMatchingTargets = reopened.filter(
        (item) => normalizeGeminiModeLabel(geminiModeItemLabel(item)) === target,
    );
    const conflictingChecked = reopened.filter(
        (item) => normalizeGeminiModeLabel(geminiModeItemLabel(item)) !== target && isItemChecked(item)
    );

    dispatchEscape();

    if (
        allMatchingTargets.length === 1
        && isItemChecked(allMatchingTargets[0])
        && !isGeminiModeItemLockedOrDisabled(allMatchingTargets[0])
        && conflictingChecked.length === 0
    ) {
        return 'success:gemini_mode_menu_v1';
    }
    return 'error: Gemini model selection readback mismatch';
}

if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
        normalizeGeminiModeLabel,
        isGeminiModeItemLockedOrDisabled,
        geminiModeItemLabel,
        findGeminiModePickerButton,
        visibleGeminiModeMenuItems,
        selectGeminiMode,
    };
}
