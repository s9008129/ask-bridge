// Shared bounded Gemini attachment DOM projection for baseline capture,
// upload verification, typed attachment probe, and pre-click re-verification.
// Loaded in browser `evaluate_script` via Rust `include_str!("gemini_attachment_projection.js")`
// and directly executed in Node unit tests.

const GEMINI_ATTACHMENT_DOC_SELECTOR = [
    '[class*="file-tile"]',
    '[data-testid*="file-chip"]',
    '[data-testid*="file-pill"]',
    '[data-testid*="file-preview"]',
    '[data-testid*="file-thumbnail"]',
    '[data-test-id*="file"]',
    'uploader-file-preview',
    'file-preview-chip',
    '[class*="file-chip"]',
    '[class*="file-pill"]',
    '[class*="file-preview"]',
    '[class*="file-thumbnail"]',
    '[class*="attachment"]',
    '[aria-label*="attachment" i]',
].join(',');

const GEMINI_ATTACHMENT_IMG_CONTAINER_SELECTOR = [
    '[data-testid*="attachment"]',
    '[data-testid*="file-"]',
    '[data-testid*="image"]',
    '[data-test-id*="file"]',
    '[class*="attachment"]',
    '[class*="file-"]',
    '[class*="preview"]',
    '[class*="thumbnail"]',
    'uploader-file-preview',
    'uploader-image-preview',
    'file-preview-chip',
].join(',');

const GEMINI_UPLOADING_DOM_SELECTOR = [
    '[aria-busy="true"]',
    '[role="progressbar"]',
    'mat-progress-spinner',
    'mat-progress-bar',
    '[data-state*="uploading" i]',
    '[data-status*="uploading" i]',
    '[data-testid*="progress" i]',
].join(',');

const GEMINI_ERROR_DOM_SELECTOR = [
    '[data-state="error"]',
    '[data-status="error"]',
    '[data-testid*="upload-error" i]',
    '[aria-label*="upload failed" i]',
].join(',');

const GEMINI_UPLOADING_TEXT_RE = /uploading|upload in progress|上傳中|正在上傳|上传中|正在上传/i;
const GEMINI_ERROR_TEXT_RE = /upload failed|failed to upload|上傳失敗|上传失败/i;

function resolveGeminiComposerRoot(doc, composerSelectors, isVisibleFn) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    const composer = (composerSelectors || [])
        .map((selector) => doc.querySelector(selector))
        .find((el) => Boolean(el) && (!isVisibleFn || isVisibleFn(el)));
    if (!composer) return null;
    const rawRoot = (typeof composer.closest === 'function'
        && (composer.closest('[data-testid*="composer"]')
            || composer.closest('input-area-v2')
            || composer.closest('form')))
        || composer.parentElement;
    if (!rawRoot || rawRoot === doc.body || rawRoot === doc.documentElement) {
        return null;
    }
    return { composer, root: rawRoot };
}

function geminiEscapeRegex(part) {
    return String(part || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function geminiMatchesExactFilename(candidateText, expectedName) {
    const expected = String(expectedName || '').trim();
    if (!expected) return false;
    const text = String(candidateText || '');
    if (!text) return false;

    const dot = expected.lastIndexOf('.');
    const basePattern = dot > 0
        ? `${geminiEscapeRegex(expected.slice(0, dot))}(?:\\((?:[1-9][0-9]*|[0-9]{8}-[0-9]{6})\\))?${geminiEscapeRegex(expected.slice(dot))}`
        : geminiEscapeRegex(expected);
    const lineRe = new RegExp(`^${basePattern}$`);
    const boundedRe = new RegExp(`(?<![A-Za-z0-9._-])${basePattern}(?![A-Za-z0-9._-])`);

    const lines = text.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
        if (lineRe.test(line)) return true;
    }
    return boundedRe.test(text.trim());
}

function collectGeminiCandidateTexts(el) {
    if (!el) return [];
    const texts = [];
    if (typeof el.querySelectorAll === 'function') {
        for (const node of Array.from(el.querySelectorAll('[data-testid*="filename"], [class*="filename"], [class*="file-name"]'))) {
            const val = String(node.innerText || node.textContent || '').trim();
            if (val) texts.push(val);
        }
    }
    for (const raw of [
        el.innerText,
        el.textContent,
        typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : '',
        typeof el.getAttribute === 'function' ? el.getAttribute('title') : '',
    ]) {
        const val = String(raw || '').trim();
        if (val) texts.push(val);
    }
    return texts;
}

function collectGeminiAttachmentLeaves(root, isVisibleFn) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const allTiles = Array.from(root.querySelectorAll(GEMINI_ATTACHMENT_DOC_SELECTOR)).filter(isVisibleFn);
    const leaves = allTiles.filter((t) => !allTiles.some((o) => o !== t && (typeof t.contains === 'function' ? t.contains(o) : false)));
    return leaves.filter((leaf) => {
        const ariaLabel = String(typeof leaf.getAttribute === 'function' ? (leaf.getAttribute('aria-label') || '') : '').toLowerCase();
        return !ariaLabel.startsWith('移除') && !ariaLabel.startsWith('remove');
    });
}

function isDomAvatarElement(img, stopBoundary) {
    let cursor = img || null;
    while (cursor && cursor !== stopBoundary) {
        if (typeof cursor.matches === 'function') {
            try {
                if (cursor.matches('[data-testid*="avatar" i], [data-test-id*="avatar" i], [class*="user-avatar" i], [class*="account-avatar" i], [class*="profile-pic" i], [aria-label*="Google Account" i], [aria-label*="Google 帳戶" i]')) {
                    return true;
                }
            } catch (_) {}
        }
        cursor = cursor.parentElement || null;
    }
    return false;
}

function findInnermostAttachmentBoundary(img, imgContainers, imgContainerSet, root) {
    let cursor = (img && img.parentElement) || null;
    while (cursor) {
        if (imgContainerSet.has(cursor)) return cursor;
        if (cursor === root) break;
        cursor = cursor.parentElement || null;
    }

    let boundary = null;
    for (const container of imgContainers) {
        if (!container || container === img || typeof container.contains !== 'function' || !container.contains(img)) continue;
        const containsDeeperContainer = imgContainers.some((other) => (
            other !== container
            && other !== img
            && typeof container.contains === 'function'
            && typeof other.contains === 'function'
            && container.contains(other)
            && other.contains(img)
        ));
        if (!containsDeeperContainer) {
            boundary = container;
            break;
        }
    }
    return boundary;
}

function projectGeminiAttachments(root, expectedDocNames, baseline = {}, isVisibleFn = () => true) {
    const docNames = Array.isArray(expectedDocNames) ? expectedDocNames : [];
    const baseDocCounts = (baseline && baseline.document_counts) || {};
    const baseUnmatched = Number((baseline && baseline.unmatched_doc_count) || 0);
    const baseImgSrcs = Array.isArray(baseline && baseline.image_srcs) ? baseline.image_srcs : [];

    if (!root) {
        return {
            composerPresent: false,
            documentCounts: {},
            unmatchedDocCount: 0,
            observedDocuments: 0,
            missingDocuments: docNames.length,
            unexpectedDocuments: 0,
            imageCount: 0,
            unexpectedImages: 0,
            newImageCount: 0,
            allImagesLoaded: false,
            imageSrcs: [],
            uploading: false,
            hasError: true,
        };
    }

    const leaves = collectGeminiAttachmentLeaves(root, isVisibleFn);
    const expectedCounts = new Map();
    for (const name of docNames) {
        expectedCounts.set(name, (expectedCounts.get(name) || 0) + 1);
    }
    const uniqueExpectedNames = Array.from(expectedCounts.keys()).sort((a, b) => b.length - a.length);

    const rawObservedCounts = new Map();
    const documentCountsObj = {};
    let unmatchedDocs = 0;

    for (const leaf of leaves) {
        const texts = collectGeminiCandidateTexts(leaf);
        const combinedText = texts.join('\n');
        const matches = uniqueExpectedNames.filter((name) => texts.some((t) => geminiMatchesExactFilename(t, name)));
        const hasOnlyImageChild = Boolean(typeof leaf.querySelector === 'function' && leaf.querySelector('img'))
            && matches.length === 0
            && !/\.([a-z0-9]{1,8})(?![A-Za-z0-9._-])/i.test(combinedText);
        if (hasOnlyImageChild) continue;
        if (matches.length > 0) {
            const matchedName = matches[0];
            rawObservedCounts.set(matchedName, (rawObservedCounts.get(matchedName) || 0) + 1);
            documentCountsObj[matchedName] = (documentCountsObj[matchedName] || 0) + 1;
        } else {
            unmatchedDocs += 1;
        }
    }

    const unmatchedDelta = Math.max(0, unmatchedDocs - baseUnmatched);
    let observedDocuments = 0;
    let missingDocuments = 0;
    let unexpectedDocuments = unmatchedDelta;

    for (const [name, expected] of expectedCounts) {
        const baseCount = Number(baseDocCounts[name] || 0);
        const observed = Math.max(0, (rawObservedCounts.get(name) || 0) - baseCount);
        observedDocuments += observed;
        missingDocuments += Math.max(0, expected - observed);
        unexpectedDocuments += Math.max(0, observed - expected);
    }

    const imgContainers = Array.from(root.querySelectorAll(GEMINI_ATTACHMENT_IMG_CONTAINER_SELECTOR)).filter(isVisibleFn);
    const imgContainerSet = new Set(imgContainers);
    const seenImg = new Set();
    const scopedImgs = [];
    for (const container of imgContainers) {
        for (const img of Array.from(container.querySelectorAll('img')).filter(isVisibleFn)) {
            if (seenImg.has(img)) continue;
            seenImg.add(img);
            const boundary = findInnermostAttachmentBoundary(img, imgContainers, imgContainerSet, root);
            if (isDomAvatarElement(img, boundary)) continue;
            scopedImgs.push(img);
        }
    }

    const baseMultiset = new Map();
    for (const src of baseImgSrcs) {
        baseMultiset.set(src, (baseMultiset.get(src) || 0) + 1);
    }
    const newImgCandidates = [];
    const allImgSrcs = [];
    for (const img of scopedImgs) {
        const src = String(img.currentSrc || img.src || '');
        allImgSrcs.push(src);
        const rem = baseMultiset.get(src) || 0;
        if (rem > 0) {
            baseMultiset.set(src, rem - 1);
        } else {
            newImgCandidates.push(img);
        }
    }

    let loadedNewImages = 0;
    let allNewImagesLoaded = newImgCandidates.length > 0;
    for (const img of newImgCandidates) {
        if (img.complete && Number(img.naturalWidth || 0) > 0 && Number(img.naturalHeight || 0) > 0) {
            loadedNewImages += 1;
        } else {
            allNewImagesLoaded = false;
        }
    }

    const allTexts = leaves.map((leaf) => collectGeminiCandidateTexts(leaf).join(' '));
    const uploadingDom = Array.from(root.querySelectorAll(GEMINI_UPLOADING_DOM_SELECTOR)).some(isVisibleFn);
    const uploadingText = allTexts.some((t) => GEMINI_UPLOADING_TEXT_RE.test(t));
    const errorDom = Array.from(root.querySelectorAll(GEMINI_ERROR_DOM_SELECTOR)).some(isVisibleFn);
    const errorText = allTexts.some((t) => GEMINI_ERROR_TEXT_RE.test(t));

    return {
        composerPresent: true,
        documentCounts: documentCountsObj,
        unmatchedDocCount: unmatchedDocs,
        observedDocuments,
        missingDocuments,
        unexpectedDocuments,
        imageCount: loadedNewImages,
        newImageCount: newImgCandidates.length,
        allImagesLoaded: allNewImagesLoaded,
        imageSrcs: allImgSrcs,
        uploading: uploadingDom || uploadingText,
        hasError: errorDom || errorText,
    };
}

function geminiPreClickVerify(root, expectedDocNames, expectedImageCount, baseline = {}, isVisibleFn = () => true) {
    const docNames = Array.isArray(expectedDocNames) ? expectedDocNames : [];
    const expImgCount = Number(expectedImageCount || 0);
    if (docNames.length === 0 && expImgCount === 0 && !root) {
        return { ok: true };
    }
    const proj = projectGeminiAttachments(root, docNames, baseline, isVisibleFn);
    if (proj.uploading || proj.hasError) {
        return { ok: false, reason: 'attachments_still_uploading_or_error' };
    }
    if (proj.missingDocuments > 0 || proj.unexpectedDocuments > 0 || proj.observedDocuments !== docNames.length) {
        return { ok: false, reason: 'missing_or_unexpected_document_before_click' };
    }
    if (expImgCount === 0) {
        if (proj.newImageCount > 0) {
            return { ok: false, reason: 'unexpected_image_before_click' };
        }
    } else {
        if (!proj.allImagesLoaded || proj.newImageCount !== expImgCount || proj.imageCount !== expImgCount) {
            return { ok: false, reason: 'image_mismatch_or_not_loaded_before_click' };
        }
    }
    return { ok: true };
}

if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
        resolveGeminiComposerRoot,
        geminiMatchesExactFilename,
        collectGeminiAttachmentLeaves,
        projectGeminiAttachments,
        geminiPreClickVerify,
    };
}
