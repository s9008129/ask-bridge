// Shared Gemini mode menu selector & readback verification helper.
// Used directly via Rust `include_str!("gemini_model_selector.js")` in `switch_model`
// and exported for Node unit testing.

const GEMINI_THINKING_TRIGGER_PATTERN = /思考程度|思考強度|思考深度|thinking\s*(?:level|effort)|reasoning\s*(?:effort|level)|思考レベル|생각\s*수준/i;
const GEMINI_THINKING_LEVEL_CANONICAL = new Map([
    ['低', 'low'],
    ['low', 'low'],
    ['中', 'medium'],
    ['中等', 'medium'],
    ['medium', 'medium'],
    ['高', 'high'],
    ['high', 'high'],
]);

function normalizeGeminiModeLabel(value) {
    return String(value || '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/^(?:已選取|currently\s*selected|selected)\s*/i, '')
        .replace(/\s*(?:已選取|currently\s*selected|selected)$/i, '')
        .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function canonicalGeminiThinkingLevel(normalizedLabel) {
    return GEMINI_THINKING_LEVEL_CANONICAL.get(normalizedLabel) || '';
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

function geminiModeItemLabels(el) {
    if (!el) return [];
    const ariaLabel = typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : '';
    const raw = String(el.innerText || el.textContent || ariaLabel || '');
    return raw.split('\n').map((line) => line.trim()).filter(Boolean);
}

function geminiModeItemLabel(el) {
    return geminiModeItemLabels(el)[0] || '';
}

function geminiModeItemMatches(el, normalizedTarget) {
    if (!normalizedTarget) return false;
    return geminiModeItemLabels(el).some((label) => normalizeGeminiModeLabel(label) === normalizedTarget);
}

function findGeminiModePickerButton(doc, isVisible) {
    const buttons = queryGeminiDocAll(doc, 'button').filter(isVisible);
    return buttons.find((button) => {
        const ariaLabel = typeof button.getAttribute === 'function' ? button.getAttribute('aria-label') : '';
        return /模式挑選器|model picker|mode picker/i.test([ariaLabel, button.textContent].filter(Boolean).join(' '));
    }) || null;
}

function queryGeminiDocAll(doc, selector) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    try {
        return Array.from(doc.querySelectorAll(selector));
    } catch (_) {
        return [];
    }
}

function visibleGeminiModeMenuItems(doc, isVisible) {
    return queryGeminiDocAll(doc, '[role="menuitem"], [role="menuitemradio"]').filter(isVisible);
}

function visibleGeminiMenuBackdrops(doc, isVisible) {
    return queryGeminiDocAll(doc, '.popover-click-shield, .cdk-overlay-backdrop').filter(isVisible);
}

function geminiMenusOrBackdropsVisible(doc, isVisible) {
    return visibleGeminiModeMenuItems(doc, isVisible).length > 0
        || visibleGeminiMenuBackdrops(doc, isVisible).length > 0;
}

function isGeminiModeItemChecked(item, isVisible) {
    if (!item || typeof item.getAttribute !== 'function') return false;
    const ariaChecked = item.getAttribute('aria-checked');
    const ariaSelected = item.getAttribute('aria-selected');
    if (ariaChecked === 'true' || ariaSelected === 'true') return true;
    if (ariaChecked === 'false' || ariaSelected === 'false') return false;
    if (item.getAttribute('aria-current') === 'true') return true;
    if (typeof item.querySelectorAll === 'function') {
        const icons = Array.from(item.querySelectorAll('mat-icon, [data-mat-icon-name], [fonticon]'));
        for (const icon of icons) {
            if (!isVisible(icon)) continue;
            const name = String(
                (typeof icon.getAttribute === 'function'
                    ? (icon.getAttribute('data-mat-icon-name') || icon.getAttribute('fonticon') || '')
                    : '')
                || icon.textContent
                || '',
            ).trim().toLowerCase();
            if (name === 'check' || name === 'done' || name === 'check_small') {
                return true;
            }
        }
    }
    return false;
}

function isGeminiSubmenuTrigger(el) {
    if (!el) return false;
    const haspopup = typeof el.getAttribute === 'function'
        ? String(el.getAttribute('aria-haspopup') || '').toLowerCase()
        : '';
    if (haspopup === 'menu' || haspopup === 'true' || haspopup === 'listbox') {
        return true;
    }
    const className = String(el.className || '');
    if (/submenu-trigger/i.test(className)) {
        return true;
    }
    return GEMINI_THINKING_TRIGGER_PATTERN.test(geminiModeItemLabels(el).join(' '));
}

function findGeminiSubmenuTriggers(doc, topLevelItems, isVisible) {
    const triggers = [];
    const seen = new Set();
    const pushIfTrigger = (el) => {
        if (!el || seen.has(el) || !isVisible(el)) return;
        if (!isGeminiSubmenuTrigger(el)) return;
        seen.add(el);
        triggers.push(el);
    };
    for (const item of topLevelItems) {
        pushIfTrigger(item);
    }
    const menuContainers = new Set();
    for (const item of topLevelItems) {
        if (item && typeof item.closest === 'function') {
            const container = item.closest(
                '[role="menu"], .mat-mdc-menu-panel, .mat-mdc-menu-content, gem-menu, .cdk-overlay-pane',
            );
            if (container) menuContainers.add(container);
        }
    }
    for (const container of menuContainers) {
        if (typeof container.querySelectorAll !== 'function') continue;
        const candidates = Array.from(
            container.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"]'),
        );
        for (const candidate of candidates) {
            pushIfTrigger(candidate);
        }
    }
    return triggers;
}

function visibleGeminiSubmenuItems(doc, topLevelItems, isVisible) {
    const topSet = new Set(topLevelItems);
    const menuItems = visibleGeminiModeMenuItems(doc, isVisible).filter((item) => !topSet.has(item));
    if (menuItems.length > 0) return menuItems;
    return queryGeminiDocAll(doc, '[role="option"]')
        .filter((item) => !topSet.has(item) && isVisible(item));
}

function matchGeminiSubmenuItems(items, normalizedTarget) {
    const exact = items.filter((item) => geminiModeItemMatches(item, normalizedTarget));
    if (exact.length > 0) return exact;
    const canonicalTarget = canonicalGeminiThinkingLevel(normalizedTarget);
    if (!canonicalTarget) return [];
    return items.filter((item) => geminiModeItemLabels(item).some(
        (label) => canonicalGeminiThinkingLevel(normalizeGeminiModeLabel(label)) === canonicalTarget,
    ));
}

async function openGeminiSubmenu(doc, trigger, topLevelItems, isVisible, sleep, pollIntervalMs, openWaitMs) {
    const stepMs = Math.max(1, pollIntervalMs);
    if (typeof trigger.dispatchEvent === 'function') {
        const makeMouse = (type) => (
            typeof MouseEvent === 'function'
                ? new MouseEvent(type, { bubbles: true, cancelable: true })
                : { type }
        );
        const makePointer = (type) => (
            typeof PointerEvent === 'function'
                ? new PointerEvent(type, { bubbles: true, cancelable: true })
                : makeMouse(type)
        );
        try { trigger.dispatchEvent(makePointer('pointerenter')); } catch (_) {}
        try { trigger.dispatchEvent(makeMouse('mouseenter')); } catch (_) {}
        try { trigger.dispatchEvent(makeMouse('mouseover')); } catch (_) {}
    }

    const hoverWaitMs = Math.min(300, openWaitMs);
    const hoverMaxPolls = Math.max(1, Math.ceil(hoverWaitMs / stepMs));
    const hoverDeadline = Date.now() + hoverWaitMs;
    for (let poll = 0; poll < hoverMaxPolls; poll += 1) {
        await sleep(pollIntervalMs);
        const submenuItems = visibleGeminiSubmenuItems(doc, topLevelItems, isVisible);
        if (submenuItems.length > 0) return submenuItems;
        if (poll + 1 >= Math.min(hoverMaxPolls, 3) && Date.now() >= hoverDeadline) break;
    }

    if (typeof trigger.click === 'function') {
        trigger.click();
    }
    const clickMaxPolls = Math.max(1, Math.ceil(openWaitMs / stepMs));
    const clickDeadline = Date.now() + openWaitMs;
    for (let poll = 0; poll < clickMaxPolls; poll += 1) {
        await sleep(pollIntervalMs);
        const submenuItems = visibleGeminiSubmenuItems(doc, topLevelItems, isVisible);
        if (submenuItems.length > 0) return submenuItems;
        if (poll + 1 >= Math.min(clickMaxPolls, 3) && Date.now() >= clickDeadline) break;
    }

    return [];
}

async function dismissGeminiMenus(doc, isVisible, sleep, dispatchEscape) {
    dispatchEscape();
    await sleep(50);
    if (!geminiMenusOrBackdropsVisible(doc, isVisible)) return;

    const [backdrop] = visibleGeminiMenuBackdrops(doc, isVisible);
    if (backdrop && typeof backdrop.click === 'function') backdrop.click();
    const stepMs = 50;
    const maxPolls = Math.max(1, Math.ceil(500 / stepMs));
    const minPolls = Math.min(maxPolls, 3);
    const deadline = Date.now() + 500;
    for (let poll = 0; poll < maxPolls; poll += 1) {
        await sleep(stepMs);
        if (!geminiMenusOrBackdropsVisible(doc, isVisible)) return;
        if (poll + 1 >= minPolls && Date.now() >= deadline) break;
    }

    if (geminiMenusOrBackdropsVisible(doc, isVisible)) {
        const pickerButton = findGeminiModePickerButton(doc, isVisible);
        if (pickerButton && typeof pickerButton.click === 'function') pickerButton.click();
        const buttonDeadline = Date.now() + 500;
        for (let poll = 0; poll < maxPolls; poll += 1) {
            await sleep(stepMs);
            if (!geminiMenusOrBackdropsVisible(doc, isVisible)) return;
            if (poll + 1 >= minPolls && Date.now() >= buttonDeadline) break;
        }
    }
}

async function selectGeminiMode(targetModelRaw, options = {}) {
    const doc = options.doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return 'error: document unavailable';
    const isVisible = options.isVisible || defaultVisibleCheck;
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const closeWaitMs = Number.isFinite(options.closeWaitMs) ? options.closeWaitMs : 2000;
    const openWaitMs = Number.isFinite(options.openWaitMs) ? options.openWaitMs : 2500;
    const pickerWaitMs = Number.isFinite(options.pickerWaitMs) ? options.pickerWaitMs : 5000;
    const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 50;
    const dispatchEscape = options.dispatchEscape || (() => {
        if (typeof KeyboardEvent !== 'undefined' && typeof doc.dispatchEvent === 'function') {
            doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        }
    });

    const target = normalizeGeminiModeLabel(targetModelRaw);
    if (!target) return 'error: empty target';

    const openTopMenu = async (button) => {
        button.click();
        const stepMs = Math.max(1, pollIntervalMs);
        const maxPolls = Math.max(1, Math.ceil(openWaitMs / stepMs));
        const minPolls = Math.min(maxPolls, 3);
        const openDeadline = Date.now() + openWaitMs;
        let items = [];
        for (let poll = 0; poll < maxPolls; poll += 1) {
            await sleep(pollIntervalMs);
            items = visibleGeminiModeMenuItems(doc, isVisible);
            if (items.length > 0) break;
            if (poll + 1 >= minPolls && Date.now() >= openDeadline) break;
        }
        return items;
    };

    const reopenTopMenuForReadback = async (button) => {
        let reopened = await openTopMenu(button);
        if (reopened.length === 0) {
            await dismissGeminiMenus(doc, isVisible, sleep, dispatchEscape);
            const retryButton = findGeminiModePickerButton(doc, isVisible);
            if (retryButton) reopened = await openTopMenu(retryButton);
        }
        return reopened;
    };

    dispatchEscape();
    await sleep(250);

    let initialButton = null;
    const pickerStepMs = Math.max(1, pollIntervalMs);
    const pickerMaxPolls = Math.max(1, Math.ceil(pickerWaitMs / pickerStepMs));
    const pickerMinPolls = Math.min(pickerMaxPolls, 3);
    const pickerDeadline = Date.now() + pickerWaitMs;
    for (let poll = 0; poll < pickerMaxPolls; poll += 1) {
        await sleep(pollIntervalMs);
        initialButton = findGeminiModePickerButton(doc, isVisible);
        if (initialButton) break;
        if (poll + 1 >= pickerMinPolls && Date.now() >= pickerDeadline) break;
    }
    if (!initialButton) return 'error: Gemini mode picker not found';

    const items = await openTopMenu(initialButton);

    const matches = items.filter((item) => geminiModeItemMatches(item, target));
    if (matches.length > 1) {
        await dismissGeminiMenus(doc, isVisible, sleep, dispatchEscape);
        return 'error: ambiguous model match in menu';
    }

    if (matches.length === 1) {
        const chosen = matches[0];
        if (isGeminiModeItemLockedOrDisabled(chosen)) {
            await dismissGeminiMenus(doc, isVisible, sleep, dispatchEscape);
            return 'error: matched model is locked or disabled';
        }

        chosen.click();

        // Poll until menu closes (up to 2000ms) instead of relying on a single fixed sleep.
        let menuClosed = false;
        const closeStepMs = Math.max(1, pollIntervalMs);
        const closeMaxPolls = Math.max(1, Math.ceil(closeWaitMs / closeStepMs));
        const closeMinPolls = Math.min(closeMaxPolls, 3);
        const closeDeadline = Date.now() + closeWaitMs;
        for (let poll = 0; poll < closeMaxPolls; poll += 1) {
            await sleep(pollIntervalMs);
            if (!geminiMenusOrBackdropsVisible(doc, isVisible)) {
                menuClosed = true;
                break;
            }
            if (poll + 1 >= closeMinPolls && Date.now() > closeDeadline) break;
        }
        if (!menuClosed) {
            await dismissGeminiMenus(doc, isVisible, sleep, dispatchEscape);
            return 'error: Gemini model menu failed to close after selection';
        }

        await sleep(250);

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
        const reopened = await reopenTopMenuForReadback(reboundButton);

        const allMatchingTargets = reopened.filter(
            (item) => geminiModeItemMatches(item, target),
        );
        const conflictingChecked = reopened.filter(
            (item) => !geminiModeItemMatches(item, target) && isGeminiModeItemChecked(item, isVisible),
        );

        await dismissGeminiMenus(doc, isVisible, sleep, dispatchEscape);

        if (
            allMatchingTargets.length === 1
            && isGeminiModeItemChecked(allMatchingTargets[0], isVisible)
            && !isGeminiModeItemLockedOrDisabled(allMatchingTargets[0])
            && conflictingChecked.length === 0
        ) {
            return 'success:gemini_mode_menu_v1';
        }
        return 'error: Gemini model selection readback mismatch';
    }

    // Target was not in the top-level menu; inspect nested submenus (e.g., "思考程度" / "Thinking level").
    const submenuTriggers = findGeminiSubmenuTriggers(doc, items, isVisible);
    const targetIsThinkingLevel = Boolean(canonicalGeminiThinkingLevel(target));
    const orderedTriggers = targetIsThinkingLevel
        ? [
            ...submenuTriggers.filter((el) => GEMINI_THINKING_TRIGGER_PATTERN.test(geminiModeItemLabels(el).join(' '))),
            ...submenuTriggers.filter((el) => !GEMINI_THINKING_TRIGGER_PATTERN.test(geminiModeItemLabels(el).join(' '))),
        ]
        : submenuTriggers;

    let matchedTriggerNormLabel = '';
    let matchedTriggerWasThinking = false;
    let chosenSubmenuItem = null;
    for (const trigger of orderedTriggers) {
        if (isGeminiModeItemLockedOrDisabled(trigger)) continue;
        const submenuItems = await openGeminiSubmenu(
            doc,
            trigger,
            items,
            isVisible,
            sleep,
            pollIntervalMs,
            openWaitMs,
        );
        if (submenuItems.length === 0) continue;
        const subMatches = matchGeminiSubmenuItems(submenuItems, target);
        if (subMatches.length > 1) {
            await dismissGeminiMenus(doc, isVisible, sleep, dispatchEscape);
            return 'error: ambiguous model match in menu';
        }
        if (subMatches.length === 1) {
            matchedTriggerNormLabel = normalizeGeminiModeLabel(geminiModeItemLabel(trigger));
            matchedTriggerWasThinking = GEMINI_THINKING_TRIGGER_PATTERN.test(geminiModeItemLabels(trigger).join(' '));
            chosenSubmenuItem = subMatches[0];
            break;
        }
    }

    if (!chosenSubmenuItem) {
        await dismissGeminiMenus(doc, isVisible, sleep, dispatchEscape);
        return 'error: model not found in menu';
    }
    if (isGeminiModeItemLockedOrDisabled(chosenSubmenuItem)) {
        await dismissGeminiMenus(doc, isVisible, sleep, dispatchEscape);
        return 'error: matched model is locked or disabled';
    }

    const wasAlreadyChecked = isGeminiModeItemChecked(chosenSubmenuItem, isVisible);
    chosenSubmenuItem.click();

    let submenuClosed = false;
    const closeStepMs = Math.max(1, pollIntervalMs);
    const closeMaxPolls = Math.max(1, Math.ceil(closeWaitMs / closeStepMs));
    const closeMinPolls = Math.min(closeMaxPolls, 3);
    const closeDeadline = Date.now() + closeWaitMs;
    for (let poll = 0; poll < closeMaxPolls; poll += 1) {
        await sleep(pollIntervalMs);
        if (!geminiMenusOrBackdropsVisible(doc, isVisible)) {
            submenuClosed = true;
            break;
        }
        if (poll + 1 >= closeMinPolls && Date.now() > closeDeadline) break;
    }
    if (!submenuClosed && !wasAlreadyChecked) {
        await dismissGeminiMenus(doc, isVisible, sleep, dispatchEscape);
        return 'error: Gemini model menu failed to close after selection';
    }
    if (geminiMenusOrBackdropsVisible(doc, isVisible)) {
        await dismissGeminiMenus(doc, isVisible, sleep, dispatchEscape);
    }
    if (geminiMenusOrBackdropsVisible(doc, isVisible)) {
        return 'error: Gemini model menu failed to close after selection';
    }

    await sleep(250);

    const reboundButton = findGeminiModePickerButton(doc, isVisible);
    if (!reboundButton) {
        return 'error: Gemini model selection readback mismatch';
    }

    // Reopen top menu + nested submenu to verify the selected submenu item is uniquely checked.
    const reopenedTop = await reopenTopMenuForReadback(reboundButton);
    const reopenedTriggers = findGeminiSubmenuTriggers(doc, reopenedTop, isVisible);
    const matchedReopenTrigger = reopenedTriggers.find(
        (el) => matchedTriggerNormLabel && normalizeGeminiModeLabel(geminiModeItemLabel(el)) === matchedTriggerNormLabel,
    ) || (matchedTriggerWasThinking
        ? reopenedTriggers.find((el) => GEMINI_THINKING_TRIGGER_PATTERN.test(geminiModeItemLabels(el).join(' ')))
        : null);

    if (!matchedReopenTrigger || isGeminiModeItemLockedOrDisabled(matchedReopenTrigger)) {
        await dismissGeminiMenus(doc, isVisible, sleep, dispatchEscape);
        return 'error: Gemini model selection readback mismatch';
    }

    const reopenedSubmenu = await openGeminiSubmenu(
        doc,
        matchedReopenTrigger,
        reopenedTop,
        isVisible,
        sleep,
        pollIntervalMs,
        openWaitMs,
    );
    const allMatchingSubmenuTargets = matchGeminiSubmenuItems(reopenedSubmenu, target);
    const matchingSubmenuSet = new Set(allMatchingSubmenuTargets);
    const conflictingSubmenuChecked = reopenedSubmenu.filter(
        (item) => !matchingSubmenuSet.has(item) && isGeminiModeItemChecked(item, isVisible),
    );

    await dismissGeminiMenus(doc, isVisible, sleep, dispatchEscape);

    if (
        allMatchingSubmenuTargets.length === 1
        && isGeminiModeItemChecked(allMatchingSubmenuTargets[0], isVisible)
        && !isGeminiModeItemLockedOrDisabled(allMatchingSubmenuTargets[0])
        && conflictingSubmenuChecked.length === 0
    ) {
        return 'success:gemini_mode_menu_v1';
    }
    return 'error: Gemini model selection readback mismatch';
}

if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
        normalizeGeminiModeLabel,
        isGeminiModeItemLockedOrDisabled,
        isGeminiModeItemChecked,
        isGeminiSubmenuTrigger,
        geminiModeItemLabel,
        findGeminiModePickerButton,
        visibleGeminiModeMenuItems,
        selectGeminiMode,
    };
}
