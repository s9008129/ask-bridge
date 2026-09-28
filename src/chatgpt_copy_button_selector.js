((options) => {
    const assistantSelector = options.assistantSelector;
    const userSelector = options.userSelector;
    const fallbackUserUnitSelector = [
        '[data-content-search-unit-key$=":user"]',
        '[data-chatgpt-search-unit-key$=":user"]',
        '[data-turn-key$=":user"]',
        '[data-turn="user"]',
        '[data-message-author-role="user"]',
        '.group\\/user-message'
    ].join(', ');
    const userCopyLabel = /複製訊息|複製信息|複製消息|复制信息|复制消息|复制訊息|copy message|メッセージをコピー|메시지 복사/i;
    const isVisible = (el) => {
        if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };

    const labelOf = (el) => [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-testid'),
        el.textContent
    ].filter(Boolean).join(' ');

    const isCopyButton = (el) => {
        const label = labelOf(el);
        return !userCopyLabel.test(label)
            && /copy|複製|复制|コピー|복사/i.test(label)
            && !/prompt|提示詞|提示词|入力|table|表格/i.test(label);
    };
    const isUserTurnControl = (el) => Boolean(
        (userSelector && el.closest(userSelector)) || el.closest(fallbackUserUnitSelector)
    );
    const copyButtonScore = (el) => {
        const label = labelOf(el);
        if (!isCopyButton(el) || !isVisible(el)) return -1;
        if (isUserTurnControl(el)) return -1;
        if (el.closest('pre, code, [class*="code"], [data-testid*="code"]')) return -1;
        if (!latest.contains(el) && !(latest.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return -1;
        if (/copy-turn-action-button/i.test(label)) return 100;
        if (/response|回應|回答|reply/i.test(label)) return 90;
        if (el.closest('[data-turn-key], [data-chatgpt-search-unit-key$=":assistant"], model-response, response-container, [data-message-author-role="assistant"], .agent-turn, [data-is-streaming], .font-claude-response')) return 50;
        return 10;
    };
    const messages = Array.from(document.querySelectorAll(assistantSelector));
    const latest = messages[messages.length - 1];
    if (!latest) return { ok: false, reason: "No assistant message found" };

    latest.scrollIntoView({ block: 'center', inline: 'nearest' });
    for (const type of ['pointerover', 'mouseover', 'mouseenter']) {
        latest.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window }));
    }

    // Copy controls for the latest assistant turn can live beside the message
    // inside the same pair container as the user turn, so walk the ancestors
    // until the transcript container that holds another assistant turn.
    const scopes = [];
    const pushScope = (el) => {
        if (el && !scopes.includes(el)) scopes.push(el);
    };
    pushScope(latest);
    pushScope(latest.closest('article'));
    pushScope(latest.closest('[data-turn="assistant"]'));
    pushScope(latest.closest('[data-testid^="conversation-turn"]'));
    for (let node = latest.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
        if (node === document.body || node === document.documentElement) break;
        const otherAssistantMessages = Array.from(node.querySelectorAll(assistantSelector))
            .filter((message) => message !== latest && !message.contains(latest) && !latest.contains(message));
        if (otherAssistantMessages.length > 0) break;
        pushScope(node);
    }

    for (const scope of scopes) {
        const buttons = Array.from(scope.querySelectorAll('button'));
        const candidates = buttons
            .map((button) => ({ button, score: copyButtonScore(button) }))
            .filter((candidate) => candidate.score >= 0)
            .sort((a, b) => b.score - a.score);
        if (candidates.length > 0) {
            const button = candidates[0].button;
            button.click();
            return { ok: true, label: labelOf(button) };
        }
    }

    return { ok: false, reason: "Copy response button not found" };
})
