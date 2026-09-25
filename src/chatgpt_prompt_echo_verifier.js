(expected, observed) => {
    const normalize = (value) => String(value || '')
        .normalize('NFC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/gu, ' ')
        .trim();
    const project = (value) => normalize(value)
        .toLocaleLowerCase('en-US')
        .replace(/[\p{P}\p{S}\s]/gu, '');
    const expectedText = normalize(expected);
    const observedText = normalize(observed);
    const expectedSemantic = project(expectedText);
    const observedSemantic = project(observedText);

    if (!expectedSemantic || !observedSemantic) {
        return {
            verified: false,
            length_ratio_ok: false,
            prefix_ok: false,
            suffix_ok: false,
            digest_ok: false,
            anchor_matches: 0,
            anchor_required: 0,
        };
    }

    const minimumLength = Math.floor(expectedSemantic.length * 0.9);
    const lengthRatioOk = observedSemantic.length >= minimumLength;
    const edgeWidth = Math.min(64, expectedSemantic.length);
    const prefix = expectedSemantic.slice(0, edgeWidth);
    const suffix = expectedSemantic.slice(-edgeWidth);
    const prefixOk = observedSemantic.includes(prefix);
    const suffixOk = observedSemantic.includes(suffix);

    const digest = expectedText.match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLocaleLowerCase('en-US') || '';
    const digestOk = !digest || observedText.toLocaleLowerCase('en-US').includes(digest);

    const anchorWidth = Math.min(48, Math.max(16, Math.floor(expectedSemantic.length / 12)));
    const maxStart = Math.max(0, expectedSemantic.length - anchorWidth);
    const fractions = [0.20, 0.35, 0.50, 0.65, 0.80];
    const anchors = [...new Set(
        fractions.map((fraction) => {
            const start = Math.min(maxStart, Math.floor(maxStart * fraction));
            return expectedSemantic.slice(start, start + anchorWidth);
        }).filter(Boolean)
    )];
    const anchorMatches = anchors.filter((anchor) => observedSemantic.includes(anchor)).length;
    const anchorRequired = anchors.length <= 2
        ? anchors.length
        : Math.max(3, Math.ceil(anchors.length * 0.6));
    const anchorsOk = anchorMatches >= anchorRequired;

    return {
        verified: lengthRatioOk && prefixOk && suffixOk && digestOk && anchorsOk,
        length_ratio_ok: lengthRatioOk,
        prefix_ok: prefixOk,
        suffix_ok: suffixOk,
        digest_ok: digestOk,
        anchor_matches: anchorMatches,
        anchor_required: anchorRequired,
    };
}
