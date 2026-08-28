((targetEffort) => {
    const markerSelector = '[data-model-reasoning-effort-slider]';
    const ordinalPattern = /第\s*(\d+)\s*(?:項|個)\s*(?:[，,、])?\s*(?:共|總共)\s*(\d+)\s*(?:項|個)|\bitem\s+(\d+)\s+of\s+(\d+)\b|\b(\d+)\s+of\s+(\d+)\b/i;
    const reasoningPattern = /reasoning|推理強度|思考強度/i;
    const interactiveRoles = new Set([
        'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem',
        'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'scrollbar',
        'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox',
        'treeitem'
    ]);
    const isVisible = (element) => {
        if (!element) return false;
        if (element.closest('[hidden], [aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
            style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    };
    const identifyingAttributes = (element) => [
        element?.getAttribute?.('aria-label'),
        element?.getAttribute?.('data-testid'),
        element?.getAttribute?.('id'),
    ].filter(Boolean).join(' ');
    const isReasoningContainer = (element) => {
        if (!element) return false;
        const role = element.getAttribute('role');
        return reasoningPattern.test(identifyingAttributes(element)) ||
            role === 'menuitem' || role === 'menu' || role === 'group';
    };
    const nearestReasoningContainer = (element) => {
        let owner = element;
        for (let depth = 0; owner && depth < 8; depth += 1, owner = owner.parentElement) {
            if (isReasoningContainer(owner)) return owner;
        }
        return null;
    };
    const isActiveContext = (context) => Boolean(
        context && (isVisible(context) || context.getAttribute('aria-expanded') === 'true' ||
            context.getAttribute('data-state') === 'open')
    );
    const activeMarkers = Array.from(document.querySelectorAll(markerSelector)).filter((marker) =>
        isActiveContext(nearestReasoningContainer(marker))
    );
    const markerCount = activeMarkers.length;
    if (markerCount > 1) {
        return {
            found: true,
            marker_count: markerCount,
            bundle_error: 'reasoning slider marker is ambiguous'
        };
    }

    const marker = activeMarkers[0] || null;
    let stateRoot = marker;
    if (!marker) {
        const legacyCandidates = Array.from(document.querySelectorAll(
            '[role="slider"][aria-valuemin][aria-valuemax], ' +
            'input[type="range"], ' +
            '[aria-valuemin][aria-valuemax][aria-valuenow]'
        )).filter((candidate) => isActiveContext(nearestReasoningContainer(candidate)));
        if (legacyCandidates.length !== 1) return { found: false, marker_count: 0 };
        stateRoot = legacyCandidates[0];
    }

    const isNativeRange = (element) => Boolean(element?.matches?.('input[type="range"]'));
    const rawStateValue = (element, key) => {
        const ariaValue = element.getAttribute('aria-value' + key);
        if (ariaValue !== null) return ariaValue;
        if (isNativeRange(element)) {
            if (key === 'min') return element.getAttribute('min');
            if (key === 'max') return element.getAttribute('max');
            return element.value;
        }
        return null;
    };
    const hasCompleteState = (element) => Boolean(element &&
        rawStateValue(element, 'min') !== null && rawStateValue(element, 'max') !== null &&
        rawStateValue(element, 'now') !== null);
    const stateCandidates = marker
        ? Array.from(marker.querySelectorAll(
            '[aria-valuemin][aria-valuemax][aria-valuenow], input[type="range"]'
        )).filter(hasCompleteState)
        : [];
    let stateOwner = null;
    if (marker && hasCompleteState(marker)) {
        if (stateCandidates.length > 0) {
            return {
                found: true,
                marker_count: markerCount,
                bundle_error: 'reasoning slider state owner is ambiguous'
            };
        }
        stateOwner = marker;
    } else if (marker && stateCandidates.length === 1) {
        stateOwner = stateCandidates[0];
    } else if (!marker && hasCompleteState(stateRoot)) {
        stateOwner = stateRoot;
    } else {
        return {
            found: true,
            marker_count: markerCount,
            bundle_error: 'reasoning slider state owner is invalid'
        };
    }

    const isFocusable = (element) => Boolean(element &&
        element.matches('input, button, select, textarea, a[href], [contenteditable="true"], [tabindex]') &&
        !element.disabled && element.getAttribute('aria-disabled') !== 'true');
    let focusOwner = isFocusable(stateOwner) ? stateOwner : null;
    if (!focusOwner) {
        const focusRoot = marker || stateOwner;
        const focusCandidates = Array.from(focusRoot.querySelectorAll(
            'input, button, select, textarea, a[href], [contenteditable="true"], [tabindex]'
        )).filter(isFocusable);
        if (focusCandidates.length !== 1) {
            return {
                found: true,
                marker_count: markerCount,
                bundle_error: 'reasoning slider focus owner is ambiguous'
            };
        }
        focusOwner = focusCandidates[0];
    }
    try {
        focusOwner.focus();
    } catch (_error) {
        return {
            found: true,
            marker_count: markerCount,
            bundle_error: 'reasoning slider focus owner is invalid'
        };
    }

    const actualOwners = [stateOwner];
    if (focusOwner !== stateOwner) actualOwners.push(focusOwner);
    const roleOwners = [marker, ...actualOwners].filter(Boolean)
        .filter((owner, index, owners) => owners.indexOf(owner) === index);
    const explicitRole = (element) => (element.getAttribute('role') || '').trim().toLowerCase();
    const implicitRole = (element) => {
        if (isNativeRange(element)) return 'slider';
        if (element.matches('button')) return 'button';
        if (element.matches('a[href]')) return 'link';
        if (element.matches('input, select, textarea')) return 'textbox';
        return null;
    };
    const ownerRoles = roleOwners.map((owner) => explicitRole(owner) || implicitRole(owner)).filter(Boolean);
    const roleConflict = ownerRoles.some((role) => role !== 'slider' && interactiveRoles.has(role));
    const roleEvidence = roleConflict ? 'conflict' :
        actualOwners.some(isNativeRange) ? 'native_range' :
        ownerRoles.includes('slider') ? 'slider' : 'missing';

    const linkedNodes = new Set();
    const scopedNodes = new Set();
    for (const owner of [marker, stateOwner, focusOwner].filter(Boolean)) {
        for (const attribute of ['aria-labelledby', 'aria-describedby']) {
            for (const id of (owner.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)) {
                const linked = document.getElementById(id);
                if (linked) linkedNodes.add(linked);
            }
        }
    }
    const reasoningContainer = nearestReasoningContainer(marker || stateOwner);
    if (reasoningContainer) {
        for (const live of reasoningContainer.querySelectorAll('[aria-live], [role="status"], [role="alert"]')) {
            if (!live.closest('[hidden], [aria-hidden="true"]')) scopedNodes.add(live);
        }
    }

    const textSources = [];
    const semanticOwners = [marker, ...actualOwners].filter(Boolean)
        .filter((owner, index, owners) => owners.indexOf(owner) === index);
    for (const owner of semanticOwners) {
        for (const value of [owner.getAttribute('aria-label'), owner.getAttribute('aria-valuetext')]) {
            if (value) textSources.push(value.trim());
        }
    }
    for (const node of [...linkedNodes, ...scopedNodes]) {
        if (node.textContent) textSources.push(node.textContent.trim());
    }

    const parseOrdinal = (value) => {
        const match = String(value || '').match(ordinalPattern);
        if (!match) return null;
        const current = Number(match[1] || match[3] || match[5]);
        const total = Number(match[2] || match[4] || match[6]);
        return Number.isInteger(current) && Number.isInteger(total) ? { current, total } : null;
    };
    const parsedOrdinals = textSources.map(parseOrdinal).filter(Boolean);
    const ordinalPresent = parsedOrdinals.length > 0;
    const firstOrdinal = parsedOrdinals[0] || null;
    const ordinalConsistent = !ordinalPresent || parsedOrdinals.every((ordinal) =>
        ordinal.current === firstOrdinal.current && ordinal.total === firstOrdinal.total
    );

    const norm = (value) => (value || '').toLowerCase()
        .replace(/[^\p{Letter}\p{Number}]+/gu, '');
    const canonicalEffort = (value) => {
        const normalized = norm(value)
            .replace(/^(已選取|已選|selected|currentlyselected)/, '')
            .replace(/(已選取|已選|selected|currentlyselected)$/, '');
        const aliases = {
            '中等': 'medium', '中等推理': 'medium', '中': 'medium',
            '高推理': 'high', '高': 'high',
            '即時推理': 'instant', '即時': 'instant',
            'instant': 'instant', 'fast': 'instant', 'light': 'instant', 'low': 'instant',
            'medium': 'medium', 'standard': 'medium', 'thinking': 'medium',
            'high': 'high', 'heavy': 'high', 'extended': 'high'
        };
        return aliases[normalized] || null;
    };
    const semanticEfforts = new Set();
    for (const value of textSources) {
        const withoutOrdinal = String(value).replace(ordinalPattern, ' ');
        for (const part of [withoutOrdinal, ...withoutOrdinal.split(/[\n，,|:：、]/)]) {
            const effort = canonicalEffort(part);
            if (effort) semanticEfforts.add(effort);
        }
    }
    const semanticEffortValues = Array.from(semanticEfforts);
    const numberValue = (value) => value === null || value === '' ? NaN : Number(value);
    const min = numberValue(rawStateValue(stateOwner, 'min'));
    const max = numberValue(rawStateValue(stateOwner, 'max'));
    const now = numberValue(rawStateValue(stateOwner, 'now'));
    const target = canonicalEffort(targetEffort);
    const ordinalConflict = ordinalPresent && (!ordinalConsistent ||
        firstOrdinal.total !== 3 || firstOrdinal.current !== now + 1);
    return {
        found: true,
        marker_present: Boolean(marker),
        marker_count: markerCount,
        state_owner_relation: marker ? (stateOwner === marker ? 'marker' : 'descendant') : null,
        focus_owner_relation: focusOwner === stateOwner ? 'state_owner' : 'descendant',
        role_evidence: roleEvidence,
        role_slider: roleEvidence === 'slider',
        min,
        max,
        now,
        matched: Boolean(target && semanticEffortValues.includes(target)),
        announcement_present: Boolean(textSources.length),
        ordinal_present: ordinalPresent,
        ordinal_current: firstOrdinal?.current ?? null,
        ordinal_total: firstOrdinal?.total ?? null,
        ordinal_consistent: ordinalConsistent,
        ordinal_conflict: ordinalConflict,
        semantic_effort: semanticEffortValues.length === 1 ? semanticEffortValues[0] : null,
        semantic_conflict: semanticEffortValues.length > 1,
        focused: document.activeElement === focusOwner
    };
})
