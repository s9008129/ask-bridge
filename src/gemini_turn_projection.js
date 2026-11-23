// Shared DOM projection helpers for Gemini response completion verification,
// text extraction, and final generated image candidate resolution.
// Used both inside browser `evaluate_script` (via Rust `include_str!`) and
// inside Node orchestration (`require('./gemini_turn_projection.js')`).

const GEMINI_PLACEHOLDER_PATTERNS = [
    /placeholder/i,
    /loading/i,
    /skeleton/i,
    /shimmer/i,
    /blur/i,
    /preview-loading/i,
];

const GEMINI_ASSISTANT_SELECTOR = 'model-response';
const GEMINI_USER_SELECTOR = 'user-query';

function geminiTurnGroups(doc, selector) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const groups = new Map();
    const ordered = [];
    for (const node of Array.from(doc.querySelectorAll(selector))) {
        const scope = (typeof node.closest === 'function'
            && (node.closest('[data-turn-key]')
                || node.closest('[data-content-search-turn-key]')
                || node.closest('[data-turn-id]')))
            || node;
        let group = groups.get(scope);
        if (!group) {
            group = { scope, nodes: [] };
            groups.set(scope, group);
            ordered.push(group);
        }
        group.nodes.push(node);
    }
    return ordered;
}

function geminiConversationId(urlOrLocation) {
    let pathname = '';
    let origin = '';
    try {
        if (typeof urlOrLocation === 'string') {
            const parsed = new URL(urlOrLocation);
            pathname = parsed.pathname || '';
            origin = parsed.origin || '';
        } else if (urlOrLocation && typeof urlOrLocation === 'object') {
            pathname = String(urlOrLocation.pathname || '');
            origin = String(urlOrLocation.origin || '');
            if (!pathname && typeof urlOrLocation.href === 'string') {
                const parsed = new URL(urlOrLocation.href);
                pathname = parsed.pathname || '';
                origin = parsed.origin || origin;
            }
        }
    } catch (_) {
        return '';
    }
    const match = pathname.match(/^(?:\/u\/\d+)?\/(?:app|c)\/([^/?#]+)/);
    if (match && match[1]) {
        return `conversation:${match[1]}`;
    }
    return origin ? `home:${origin}` : '';
}

function isGeminiPlaceholderElement(element) {
    let cursor = element || null;
    let steps = 0;
    while (cursor && steps < 8) {
        steps += 1;
        const tag = String(cursor.tagName || '').toLowerCase();
        if (tag === 'body' || tag === 'html' || tag === 'model-response') {
            break;
        }
        if (tag === 'mat-progress-spinner' || tag === 'mat-spinner') {
            return true;
        }
        if (typeof cursor.getAttribute === 'function') {
            if (cursor.getAttribute('aria-busy') === 'true' || cursor.getAttribute('data-loading') === 'true') {
                return true;
            }
        }
        const classStr = Array.isArray(cursor.classList)
            ? cursor.classList.join(' ')
            : (cursor.classList && typeof cursor.classList[Symbol.iterator] === 'function'
                ? Array.from(cursor.classList).join(' ')
                : String(cursor.className || ''));
        const testId = typeof cursor.getAttribute === 'function'
            ? String(cursor.getAttribute('data-test-id') || cursor.getAttribute('data-testid') || '')
            : '';
        const idAttr = typeof cursor.getAttribute === 'function'
            ? String(cursor.getAttribute('id') || '')
            : '';
        const marker = `${tag} ${classStr} ${testId} ${idAttr}`;
        if (GEMINI_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(marker))) {
            return true;
        }
        cursor = cursor.parentElement || null;
    }
    return false;
}

function isGeminiGenerating(rootDoc, latestGroup, stopSelectors, isVisibleControl) {
    const doc = rootDoc || (typeof document !== 'undefined' ? document : null);
    const visibleCheck = typeof isVisibleControl === 'function'
        ? isVisibleControl
        : (el) => {
            if (!el) return false;
            if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' && typeof el.getBoundingClientRect === 'function') {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            }
            return true;
        };
    if (doc && Array.isArray(stopSelectors)) {
        for (const selector of stopSelectors) {
            const btn = doc.querySelector(selector);
            if (btn && visibleCheck(btn)) {
                return true;
            }
        }
    }
    const scopeNodes = latestGroup && Array.isArray(latestGroup.nodes)
        ? latestGroup.nodes
        : (latestGroup && latestGroup.scope ? [latestGroup.scope] : []);
    for (const node of scopeNodes) {
        if (!node) continue;
        const turnRoot = typeof node.closest === 'function'
            ? (node.closest('model-response') || node)
            : node;
        if (typeof turnRoot.getAttribute === 'function') {
            if (turnRoot.getAttribute('aria-busy') === 'true' || turnRoot.getAttribute('data-loading') === 'true') {
                return true;
            }
        }
        if (turnRoot.classList && typeof turnRoot.classList.contains === 'function' && turnRoot.classList.contains('generating')) {
            return true;
        }
        if (typeof turnRoot.querySelectorAll === 'function') {
            const busySignals = Array.from(turnRoot.querySelectorAll('[aria-busy="true"], [data-loading="true"], .generating, mat-progress-spinner, mat-spinner, [role="progressbar"]'));
            if (busySignals.some(visibleCheck)) {
                return true;
            }
        }
    }
    return false;
}

function isWithinUserQuery(el) {
    let cursor = el || null;
    let steps = 0;
    while (cursor && steps < 24) {
        steps += 1;
        const tag = String(cursor.tagName || '').toLowerCase();
        if (tag === 'user-query') return true;
        if (tag === 'model-response' || tag === 'body' || tag === 'html') return false;
        cursor = cursor.parentElement || null;
    }
    return typeof el?.closest === 'function' ? Boolean(el.closest('user-query')) : false;
}

function resolveGeminiImageArtifactId(img) {
    const readAttr = (el, name) => (el && typeof el.getAttribute === 'function' ? String(el.getAttribute(name) || '').trim() : '');
    const genericNames = new Set(['generated-image', 'single-image', 'img', 'image']);
    const isContainer = (el) => {
        if (!el) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (tag === 'generated-image' || tag === 'single-image') return true;
        const testId = readAttr(el, 'data-test-id') || readAttr(el, 'data-testid');
        const cls = el.classList ? Array.from(el.classList).join(' ') : String(el.className || '');
        return /generated-image|image-generation/i.test(`${testId} ${cls}`);
    };
    const readIdentifyingAttr = (el) => {
        for (const attr of ['data-artifact-id', 'data-image-id', 'data-response-id', 'id']) {
            const val = readAttr(el, attr);
            if (val && !genericNames.has(val.toLowerCase())) {
                return val;
            }
        }
        return '';
    };
    let cursor = img || null;
    let steps = 0;
    let seenGeneratedContainer = false;
    let attachmentIndex = '';
    while (cursor && steps < 10) {
        steps += 1;
        const tag = String(cursor.tagName || '').toLowerCase();
        if (tag === 'model-response' || tag === 'user-query' || tag === 'body' || tag === 'html') break;
        const inContainer = isContainer(cursor);
        if (inContainer) {
            seenGeneratedContainer = true;
            if (!attachmentIndex) {
                attachmentIndex = readAttr(cursor, 'data-image-attachment-index');
            }
        }
        if (cursor === img || inContainer) {
            const id = readIdentifyingAttr(cursor);
            if (id) return id;
        }
        cursor = cursor.parentElement || null;
    }
    if (seenGeneratedContainer) {
        const src = String((img && (img.currentSrc || img.src || readAttr(img, 'src'))) || '').trim();
        const blobPrefix = 'blob:https://gemini.google.com/';
        if (src.startsWith(blobPrefix) && src.length > blobPrefix.length) {
            return `blob:${src.slice(blobPrefix.length)}`;
        }
        if (attachmentIndex) {
            return `generated-image-idx:${attachmentIndex}`;
        }
    }
    return '';
}

function geminiTurnIdentity(group) {
    const nodes = group && Array.isArray(group.nodes) ? group.nodes : [];
    const fallback = nodes.length > 0 ? nodes[nodes.length - 1] : null;
    const scope = group ? group.scope : null;
    const resolveAttr = (el, name) => (el && typeof el.getAttribute === 'function' ? (el.getAttribute(name) || '') : '');
    const turn = scope && typeof scope.closest === 'function'
        ? (scope.closest('section[data-turn="assistant"][data-turn-id]')
            || scope.closest('[data-turn="assistant"][data-turn-id]')
            || scope.closest('[data-turn-key]')
            || scope.closest('[data-response-id]')
            || scope.closest('model-response')
            || scope)
        : (scope || fallback);

    let turnId = '';
    if (turn) {
        turnId = resolveAttr(turn, 'data-turn-id')
            || resolveAttr(turn, 'data-turn-key')
            || resolveAttr(turn, 'data-response-id')
            || (String(turn.tagName || '').toLowerCase() === 'model-response' ? resolveAttr(turn, 'id') : '');
        if (!turnId && typeof turn.closest === 'function') {
            const convContainer = turn.closest('.conversation-container[id]');
            turnId = resolveAttr(convContainer, 'id');
        }
        if (!turnId && typeof turn.querySelector === 'function') {
            const keyed = turn.querySelector('[data-turn-id], [data-turn-key], [data-response-id], message-content[id], [id^="message-content-id-"], [id^="model-response-message-content"]');
            turnId = resolveAttr(keyed, 'data-turn-id')
                || resolveAttr(keyed, 'data-turn-key')
                || resolveAttr(keyed, 'data-response-id')
                || resolveAttr(keyed, 'id');
        }
    }
    if (!turnId && fallback) {
        turnId = resolveAttr(fallback, 'data-chatgpt-selection-message-id')
            || resolveAttr(fallback, 'data-response-id')
            || resolveAttr(fallback, 'data-turn-id')
            || resolveAttr(fallback, 'id');
    }

    const artifactSet = new Set();
    const genericNames = new Set(['generated-image', 'single-image', 'img', 'image']);
    const scanNodes = [];
    if (turn) scanNodes.push(turn);
    for (const n of nodes) {
        if (n && n !== turn) scanNodes.push(n);
    }
    for (const root of scanNodes) {
        if (!root || typeof root.querySelectorAll !== 'function') continue;
        for (const el of Array.from(root.querySelectorAll('[id^="image-"], [data-response-id], [data-image-id], [data-artifact-id], generated-image[id], single-image[id]'))) {
            if (isWithinUserQuery(el)) continue;
            const explicitId = resolveAttr(el, 'data-artifact-id')
                || resolveAttr(el, 'data-image-id')
                || resolveAttr(el, 'data-response-id')
                || resolveAttr(el, 'id');
            if (explicitId && !genericNames.has(explicitId.toLowerCase())) {
                artifactSet.add(explicitId);
            }
        }
    }
    return {
        turnId: String(turnId || '').trim(),
        artifactIds: Array.from(artifactSet).sort(),
    };
}

function findGeminiFinalGeneratedImages(latestGroup, minimumImageDimension = 200) {
    const nodes = latestGroup && Array.isArray(latestGroup.nodes) ? latestGroup.nodes : [];
    const results = [];
    const seenKeys = new Set();

    const isAllowedImageUrl = (src) => {
        if (!src || typeof src !== 'string') return false;
        const lower = src.toLowerCase();
        if (lower.includes('avatar') || lower.includes('profile')) return false;
        return lower.startsWith('https://')
            || lower.startsWith('http://')
            || lower.startsWith('blob:')
            || lower.startsWith('data:image/');
    };

    const acceptImage = (img) => {
        if (!img || isWithinUserQuery(img)) return;
        const src = String(img.currentSrc || img.src || (typeof img.getAttribute === 'function' ? img.getAttribute('src') : '') || '');
        if (!isAllowedImageUrl(src)) return;
        const naturalWidth = Number(img.naturalWidth || 0);
        const naturalHeight = Number(img.naturalHeight || 0);
        if (!img.complete || naturalWidth < minimumImageDimension || naturalHeight < minimumImageDimension) {
            return;
        }
        if (isGeminiPlaceholderElement(img)) return;
        const artifactId = resolveGeminiImageArtifactId(img);
        if (!artifactId) return;
        const dedupeKey = `${artifactId}::${src}`;
        if (seenKeys.has(dedupeKey)) return;
        seenKeys.add(dedupeKey);
        results.push({
            artifactId,
            src,
            naturalWidth,
            naturalHeight,
        });
    };

    const containerSelector = [
        'generated-image img',
        'single-image img',
        '[data-test-id*="generated-image"] img',
        '[data-testid*="generated-image"] img',
        '[class*="generated-image"] img',
        '[class*="image-generation"] img',
    ].join(', ');

    for (const node of nodes) {
        if (!node || typeof node.querySelectorAll !== 'function') continue;
        const containerImgs = Array.from(node.querySelectorAll(containerSelector));
        for (const img of containerImgs) acceptImage(img);
    }
    return results;
}

function geminiElementToMarkdown(element) {
    if (!element) return '';
    let markdown = '';
    const processedSrcs = new Set();
    const walk = (node) => {
        if (!node) return;
        if (node.nodeType === 3) {
            markdown += node.textContent || '';
            return;
        }
        if (node.nodeType !== 1) return;

        const tag = String(node.tagName || '').toLowerCase();
        const classText = node.classList ? Array.from(node.classList).join(' ') : String(node.className || '');
        if (
            (node.classList && typeof node.classList.contains === 'function' && node.classList.contains('sr-only'))
            || /screen-reader|visually-hidden|cdk-visually-hidden/.test(classText)
            || tag === 'button'
            || tag === 'style'
            || tag === 'script'
            || tag === 'mat-icon'
        ) {
            return;
        }

        if (tag === 'pre') {
            const codeEl = typeof node.querySelector === 'function' ? node.querySelector('code') : null;
            const codeClassList = codeEl && codeEl.classList ? Array.from(codeEl.classList) : [];
            const langClass = codeClassList.find((c) => c.startsWith('language-')) || '';
            const lang = langClass ? langClass.replace('language-', '') : '';
            const codeText = codeEl ? (codeEl.textContent || '') : (node.textContent || '');
            markdown += `\n\`\`\`${lang}\n${codeText}\n\`\`\`\n`;
            return;
        }

        if (tag === 'code') {
            const insidePre = typeof node.closest === 'function' && Boolean(node.closest('pre'));
            if (!insidePre) {
                markdown += `\`${node.textContent || ''}\``;
                return;
            }
        }

        if (tag === 'strong' || tag === 'b') {
            markdown += '**';
            for (const child of node.childNodes || []) walk(child);
            markdown += '**';
            return;
        }

        if (tag === 'em' || tag === 'i') {
            markdown += '*';
            for (const child of node.childNodes || []) walk(child);
            markdown += '*';
            return;
        }

        if (tag === 'a') {
            const href = typeof node.getAttribute === 'function' ? (node.getAttribute('href') || '') : '';
            const text = node.textContent || '';
            if (href && text) {
                markdown += `[${text}](${href})`;
                return;
            }
        }

        if (tag === 'p' || tag === 'br') markdown += '\n';
        if (tag === 'h1') markdown += '\n# ';
        if (tag === 'h2') markdown += '\n## ';
        if (tag === 'h3') markdown += '\n### ';
        if (tag === 'h4') markdown += '\n#### ';
        if (tag === 'h5') markdown += '\n##### ';
        if (tag === 'h6') markdown += '\n###### ';
        if (tag === 'li') markdown += '\n* ';

        if (tag === 'img') {
            const src = typeof node.getAttribute === 'function' ? (node.getAttribute('src') || '') : '';
            const alt = (typeof node.getAttribute === 'function' ? node.getAttribute('alt') : '') || 'image';
            if (src && !src.includes('avatar') && !src.includes('profile')) {
                if (processedSrcs.has(src)) return;
                processedSrcs.add(src);
                markdown += `\n![${alt}](${src})\n`;
                return;
            }
        }

        for (const child of node.childNodes || []) {
            walk(child);
        }

        if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'].includes(tag)) {
            markdown += '\n';
        }
    };

    walk(element);
    return markdown.trim().replace(/\n{3,}/g, '\n\n');
}

if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
        GEMINI_PLACEHOLDER_PATTERNS,
        GEMINI_ASSISTANT_SELECTOR,
        GEMINI_USER_SELECTOR,
        geminiConversationId,
        geminiTurnGroups,
        isGeminiPlaceholderElement,
        isGeminiGenerating,
        geminiTurnIdentity,
        findGeminiFinalGeneratedImages,
        geminiElementToMarkdown,
    };
}
