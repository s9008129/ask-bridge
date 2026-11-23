// Target-locked SSRF-hardened CDP image downloader for Gemini generated images.
// Enforces:
// 1. Exact shared identity & final-image candidate projection from `gemini_turn_projection.js`.
// 2. Mandatory non-empty expectedIdentity.turn_id & exact before/after candidate identity lock.
// 3. Per-hop HTTPS + allowlist + full DNS resolution verifying ALL IPs are public,
//    pinning validated IP on `https.request`/`http.request` with zero cookies/credentials.
// 4. Hard 30s per-image wall-clock deadline (DNS + redirects + body), max 3 redirects,
//    streaming byte cutoff, pure magic-byte sniffing, and two-phase private temp -> fsync ->
//    final identity check -> atomic publish (failing preserves any existing target files).

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

const [tokenArg, outputArg, expectedIdentityJsonArg] = process.argv.slice(1);

const GEMINI_ORIGIN = 'https://gemini.google.com';
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 30000;
const CDP_CALL_TIMEOUT_MS = 10000;
const CDP_OPEN_TIMEOUT_MS = 5000;
const DEFAULT_MINIMUM_IMAGE_DIMENSION = 256;
const MINIMUM_IMAGE_DIMENSION = (
    typeof __GEMINI_MIN_IMAGE_DIMENSION__ === 'number'
    && Number.isFinite(__GEMINI_MIN_IMAGE_DIMENSION__)
    && __GEMINI_MIN_IMAGE_DIMENSION__ > 0
) ? __GEMINI_MIN_IMAGE_DIMENSION__ : DEFAULT_MINIMUM_IMAGE_DIMENSION;

const GEMINI_TURN_PROJECTION_EMBED = (() => {
    if (typeof __GEMINI_TURN_PROJECTION_RAW__ === 'string') {
        return __GEMINI_TURN_PROJECTION_RAW__;
    }
    const baseDir = typeof __dirname === 'string'
        ? __dirname
        : path.join(typeof process.cwd === 'function' ? process.cwd() : '.', 'src');
    return fs.readFileSync(path.join(baseDir, 'gemini_turn_projection.js'), 'utf8');
})();

const ALLOWED_GEMINI_IMAGE_HOST_PATTERNS = [
    /^googleusercontent\.com$/i,
    /^lh\d*\.googleusercontent\.com$/i,
    /^[^.]+\.googleusercontent\.com$/i,
    /^ggpht\.com$/i,
    /^[^.]+\.ggpht\.com$/i,
    /^gemini\.google\.com$/i,
    /^storage\.googleapis\.com$/i,
];

function isAllowedGeminiImageHost(hostname) {
    const clean = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!clean || clean === 'localhost' || clean.endsWith('.localhost')) return false;
    return ALLOWED_GEMINI_IMAGE_HOST_PATTERNS.some((pattern) => pattern.test(clean));
}

function isAllowedGeminiImageUrl(urlString, options = {}) {
    let parsed;
    try {
        parsed = new URL(urlString);
    } catch (_) {
        return { ok: false, reason: 'invalid_url' };
    }
    if (parsed.username || parsed.password) {
        return { ok: false, reason: 'credentials_disallowed' };
    }
    const trustedOrigins = Array.isArray(options.testTrustedOrigins) ? options.testTrustedOrigins : [];
    if (trustedOrigins.includes(parsed.origin)) {
        return { ok: true, parsed };
    }
    if (parsed.protocol !== 'https:') {
        return { ok: false, reason: `disallowed_scheme:${parsed.protocol}` };
    }
    const bareHost = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(bareHost) !== 0 && isPrivateOrLoopbackIp(bareHost)) {
        return { ok: false, reason: `private_ip:${bareHost}` };
    }
    if (!isAllowedGeminiImageHost(bareHost)) {
        return { ok: false, reason: `untrusted_host:${bareHost}` };
    }
    return { ok: true, parsed };
}

function isAllowedGeminiBlobUrl(blobUrl) {
    const raw = String(blobUrl || '');
    if (!raw.startsWith('blob:')) return false;
    try {
        const inner = new URL(raw.slice('blob:'.length));
        return inner.origin === GEMINI_ORIGIN;
    } catch (_) {
        return false;
    }
}

function assertAllowedGeminiImageHost(urlString) {
    const check = isAllowedGeminiImageUrl(urlString);
    if (!check.ok) {
        if (String(check.reason).startsWith('disallowed_scheme:')) {
            throw new Error(`Blocked non-HTTPS Gemini image download URL: ${check.reason}`);
        }
        throw new Error(`Blocked untrusted Gemini image URL (${check.reason}): ${urlString}`);
    }
    return check.parsed;
}

function isPrivateIpv4Octets(a, b, c, d) {
    if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
    if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 anycast relay
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
    if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 multicast
    if (a >= 240) return true; // 240.0.0.0/4 reserved & broadcast
    return false;
}

function expandIpv6Groups(rawIp) {
    let cleaned = String(rawIp || '').trim().toLowerCase();
    const zoneIdx = cleaned.indexOf('%');
    if (zoneIdx !== -1) cleaned = cleaned.slice(0, zoneIdx);
    if (!cleaned || cleaned.includes(':::')) return null;

    let tailGroups = [];
    const lastColon = cleaned.lastIndexOf(':');
    if (lastColon !== -1 && cleaned.slice(lastColon + 1).includes('.')) {
        const ipv4Part = cleaned.slice(lastColon + 1);
        const octets = ipv4Part.split('.');
        if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o))) return null;
        const nums = octets.map(Number);
        if (nums.some((n) => n < 0 || n > 255)) return null;
        tailGroups = [(nums[0] << 8) | nums[1], (nums[2] << 8) | nums[3]];
        cleaned = cleaned.slice(0, lastColon);
        if (!cleaned) cleaned = '::';
    }

    const halves = cleaned.split('::');
    if (halves.length > 2) return null;
    const leftParts = halves[0] ? halves[0].split(':') : [];
    const rightParts = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const parseHex = (part) => (/^[0-9a-f]{1,4}$/i.test(part) ? parseInt(part, 16) : null);
    const left = leftParts.map(parseHex);
    const right = rightParts.map(parseHex);
    if (left.some((v) => v === null) || right.some((v) => v === null)) return null;

    if (halves.length === 1) {
        const combined = [...left, ...tailGroups];
        return combined.length === 8 ? combined : null;
    }
    const missing = 8 - (left.length + right.length + tailGroups.length);
    if (missing < 0) return null;
    return [...left, ...new Array(missing).fill(0), ...right, ...tailGroups];
}

function isPrivateOrLoopbackIp(ip) {
    const raw = String(ip || '').trim().replace(/^\[|\]$/g, '');
    if (!raw || raw.includes('%')) return true;

    const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
    if (dotted) {
        return isPrivateIpv4Octets(
            Number(dotted[1]),
            Number(dotted[2]),
            Number(dotted[3]),
            Number(dotted[4]),
        );
    }

    const groups = expandIpv6Groups(raw);
    if (!groups) return true;

    const isMapped = groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff;
    const isCompatible = groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0;
    if (isMapped || isCompatible) {
        return isPrivateIpv4Octets(
            (groups[6] >> 8) & 0xff,
            groups[6] & 0xff,
            (groups[7] >> 8) & 0xff,
            groups[7] & 0xff,
        );
    }

    // Positive IPv6 allowlist: ONLY global unicast 2000::/3 minus special-purpose sub-ranges.
    const g0 = groups[0];
    const g1 = groups[1];
    const g2 = groups[2];
    if ((g0 & 0xe000) !== 0x2000) return true; // rejects ::/128, ::1, 64:ff9b::/96, 100::/64, fc00::/7, fe80::/10, fec0::/10, ff00::/8, etc.
    if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
    if (g0 === 0x2001 && g1 === 0x0000) return true; // 2001::/32 Teredo
    if (g0 === 0x2001 && g1 === 0x0002 && g2 === 0x0000) return true; // 2001:2::/48 benchmarking
    if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0010) return true; // 2001:10::/28 ORCHID
    if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0020) return true; // 2001:20::/28 ORCHIDv2
    if (g0 === 0x2002) return true; // 2002::/16 6to4
    return false;
}

function decodeDataImageUrl(dataUrl, maxBytes = MAX_IMAGE_BYTES) {
    const match = /^data:image\/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!match) {
        throw new Error('Malformed data:image base64 payload');
    }
    const payload = match[2];
    const padding = payload.endsWith('==') ? 2 : (payload.endsWith('=') ? 1 : 0);
    const estimatedBytes = Math.ceil((payload.length * 3) / 4) - padding;
    if (estimatedBytes > maxBytes) {
        throw new Error('Image data URL exceeds maximum allowed bytes before decode');
    }
    const buffer = Buffer.from(payload, 'base64');
    if (buffer.length > maxBytes) {
        throw new Error('Image data URL exceeds maximum allowed bytes');
    }
    const subtype = match[1].toLowerCase().replace('+xml', '');
    return {
        ext: subtype === 'jpeg' ? 'jpg' : subtype,
        buffer,
    };
}

async function resolveAndValidatePublicAddress(urlString, lookupAll = dns.promises.lookup, options = {}) {
    const check = isAllowedGeminiImageUrl(urlString, options);
    if (!check.ok) {
        throw new Error(`Blocked redirect target: ${urlString} (${check.reason})`);
    }
    const parsed = check.parsed;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const trustedOrigins = Array.isArray(options.testTrustedOrigins) ? options.testTrustedOrigins : [];
    const allowLoopbackForTest = trustedOrigins.includes(parsed.origin);

    if (net.isIP(hostname) !== 0) {
        if (!allowLoopbackForTest && isPrivateOrLoopbackIp(hostname)) {
            throw new Error(`Blocked private/loopback IP address: ${hostname}`);
        }
        return { address: hostname, family: net.isIP(hostname), parsed };
    }
    let timer;
    const timeoutMs = Number.isFinite(options.remainingMs) ? Math.max(1, options.remainingMs) : REQUEST_TIMEOUT_MS;
    const records = await Promise.race([
        lookupAll(hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Gemini image DNS resolution timed out')), timeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));

    if (!Array.isArray(records) || records.length === 0) {
        throw new Error(`DNS resolution returned no addresses for ${hostname}`);
    }
    for (const record of records) {
        if (!record || !record.address || (!allowLoopbackForTest && isPrivateOrLoopbackIp(record.address))) {
            throw new Error(`Blocked private/non-public DNS address ${record && record.address} for ${hostname}`);
        }
    }
    const primary = records[0];
    return {
        address: primary.address,
        family: primary.family || net.isIP(primary.address) || 4,
        parsed,
    };
}

function fetchHopPinned({ parsed, pinnedAddress, pinnedFamily, maxBytes, timeoutMs, httpsModule, httpModule }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let req;
        let resRef = null;
        let wallTimer = null;
        const cleanupTimer = () => {
            if (wallTimer) {
                clearTimeout(wallTimer);
                wallTimer = null;
            }
        };
        const fail = (err) => {
            if (settled) return;
            settled = true;
            cleanupTimer();
            if (resRef && !resRef.destroyed) resRef.destroy();
            if (req && !req.destroyed) req.destroy();
            reject(err);
        };

        wallTimer = setTimeout(() => {
            fail(new Error('Gemini image request timed out'));
        }, Math.max(1, timeoutMs));

        const headers = {
            Host: parsed.host,
            'User-Agent': 'ask-bridge',
        };

        const transport = parsed.protocol === 'http:' ? (httpModule || http) : (httpsModule || https);
        const options = {
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
            path: `${parsed.pathname}${parsed.search}`,
            method: 'GET',
            headers,
            ...(parsed.protocol === 'https:' ? { servername: parsed.hostname, rejectUnauthorized: true } : {}),
            lookup: (_host, lookupOpts, cb) => {
                if (typeof lookupOpts === 'function') {
                    return lookupOpts(null, pinnedAddress, pinnedFamily);
                }
                if (lookupOpts && lookupOpts.all) {
                    return cb(null, [{ address: pinnedAddress, family: pinnedFamily }]);
                }
                return cb(null, pinnedAddress, pinnedFamily);
            },
        };

        req = transport.request(options, (res) => {
            resRef = res;
            const status = res.statusCode || 0;
            if ([301, 302, 303, 307, 308].includes(status)) {
                const location = res.headers && res.headers.location;
                settled = true;
                cleanupTimer();
                res.destroy();
                req.destroy();
                resolve({ redirect: location || '' });
                return;
            }
            if (status < 200 || status >= 300) {
                res.resume();
                fail(new Error(`HTTP ${status} fetching Gemini image`));
                return;
            }
            const rawLength = res.headers && res.headers['content-length'];
            if (rawLength !== undefined) {
                const declared = Number(rawLength);
                if (Number.isFinite(declared) && declared > maxBytes) {
                    fail(new Error('Image size exceeds maximum allowed bytes'));
                    return;
                }
            }
            const chunks = [];
            let totalBytes = 0;
            res.on('data', (chunk) => {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                totalBytes += buf.length;
                if (totalBytes > maxBytes) {
                    fail(new Error('Image size exceeds maximum allowed bytes'));
                    return;
                }
                chunks.push(buf);
            });
            res.on('end', () => {
                if (settled) return;
                settled = true;
                cleanupTimer();
                const buffer = Buffer.concat(chunks, totalBytes);
                const ext = sniffImageExt(buffer);
                resolve({
                    status,
                    ext,
                    buffer,
                });
            });
            res.on('error', fail);
        });

        req.on('error', fail);
        req.end();
    });
}

async function fetchWithValidatedRedirects(initialUrl, options = {}) {
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_IMAGE_BYTES;
    const maxRedirects = Number.isFinite(options.maxRedirects) ? options.maxRedirects : MAX_REDIRECTS;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS;
    const lookupAll = options.lookupAll || dns.promises.lookup;
    const deadlineAt = Date.now() + timeoutMs;

    let currentUrl = initialUrl;
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
        const remainingBeforeDns = deadlineAt - Date.now();
        if (remainingBeforeDns <= 0) {
            throw new Error('Gemini image request timed out');
        }
        const { address, family, parsed } = await resolveAndValidatePublicAddress(currentUrl, lookupAll, {
            ...options,
            remainingMs: remainingBeforeDns,
        });
        const remainingBeforeHop = deadlineAt - Date.now();
        if (remainingBeforeHop <= 0) {
            throw new Error('Gemini image request timed out');
        }
        const result = await fetchHopPinned({
            parsed,
            pinnedAddress: address,
            pinnedFamily: family,
            maxBytes,
            timeoutMs: remainingBeforeHop,
            httpsModule: options.httpsModule,
            httpModule: options.httpModule,
        });
        if (result && typeof result.redirect === 'string') {
            if (!result.redirect) {
                throw new Error('Redirect response missing Location header');
            }
            if (redirects >= maxRedirects) {
                throw new Error('Too many redirects fetching Gemini image');
            }
            currentUrl = new URL(result.redirect, currentUrl).toString();
            continue;
        }
        return result;
    }
    throw new Error('Too many redirects fetching Gemini image');
}

const downloadWithManualRedirects = fetchWithValidatedRedirects;

// Pure magic-byte verification (never trusts Content-Type header alone).
function sniffImageExt(buf) {
    if (!Buffer.isBuffer(buf)) return null;
    if (
        buf.length >= 8
        && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
        && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A
    ) {
        return 'png';
    }
    if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
        return 'jpg';
    }
    if (
        buf.length >= 12
        && buf.toString('ascii', 0, 4) === 'RIFF'
        && buf.toString('ascii', 8, 12) === 'WEBP'
    ) {
        return 'webp';
    }
    return null;
}

function writeTempPrivateFile(targetDir, prefixName, buffer) {
    const tmpPath = path.join(targetDir, `.${prefixName}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
    const fd = fs.openSync(tmpPath, flags, 0o600);
    let closed = false;
    try {
        let offset = 0;
        while (offset < buffer.length) {
            offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
        }
        fs.fsyncSync(fd);
        if (typeof fs.fchmodSync === 'function') {
            fs.fchmodSync(fd, 0o600);
        }
        fs.closeSync(fd);
        closed = true;
        return tmpPath;
    } catch (err) {
        if (!closed) {
            try { fs.closeSync(fd); } catch (_) {}
        }
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        throw err;
    }
}

function atomicWritePrivateFile(targetPath, buffer) {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = writeTempPrivateFile(dir, path.basename(targetPath), buffer);
    try {
        fs.renameSync(tmpPath, targetPath);
        fs.chmodSync(targetPath, 0o600);
    } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        throw err;
    }
}

function resolveOutputFilePaths(imageOutput, extList) {
    const total = extList.length;
    const raw = String(imageOutput || '').trim();
    if (!raw) {
        throw new Error('Missing Gemini image output path');
    }
    let existingIsDir = false;
    try {
        existingIsDir = fs.statSync(raw).isDirectory();
    } catch (_) {
        existingIsDir = false;
    }
    const endsWithSep = raw.endsWith(path.sep) || raw.endsWith('/') || raw.endsWith('\\');
    const parsedExt = path.extname(raw);
    const isFileTarget = !existingIsDir && !endsWithSep && Boolean(parsedExt);

    if (isFileTarget) {
        const parentDir = path.dirname(raw);
        if (total === 1) {
            return [raw];
        }
        const stem = path.basename(raw, parsedExt);
        return extList.map((ext, idx) => path.join(parentDir, `${stem}_${idx + 1}.${ext}`));
    }
    const epoch = Math.floor(Date.now() / 1000);
    return extList.map((ext, idx) => path.join(raw, `generated_${epoch}_${idx + 1}.${ext}`));
}

async function callCdp(ws, method, params = {}, timeoutMs = CDP_CALL_TIMEOUT_MS) {
    const id = Math.floor(Math.random() * 1e9);
    const effectiveTimeoutMs = Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : CDP_CALL_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const cleanup = () => {
            if (ws && typeof ws.removeEventListener === 'function') {
                ws.removeEventListener('message', onMessage);
                ws.removeEventListener('close', onClose);
                ws.removeEventListener('error', onError);
            }
            if (timer !== null) clearTimeout(timer);
        };
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
        };
        const onMessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id !== id) return;
            if (msg.error) finish(reject, new Error(msg.error.message || 'CDP error'));
            else finish(resolve, msg.result);
        };
        const onClose = () => finish(reject, new Error('CDP connection closed before response'));
        const onError = () => finish(reject, new Error('CDP connection failed'));
        if (!ws || typeof ws.addEventListener !== 'function' || typeof ws.send !== 'function') {
            finish(reject, new Error('Invalid CDP WebSocket'));
            return;
        }
        if (Number.isFinite(ws.readyState) && ws.readyState >= 2) {
            finish(reject, new Error('CDP connection is not open'));
            return;
        }
        ws.addEventListener('message', onMessage);
        ws.addEventListener('close', onClose);
        ws.addEventListener('error', onError);
        timer = setTimeout(
            () => finish(reject, new Error(`CDP call timed out: ${method}`)),
            effectiveTimeoutMs,
        );
        try {
            ws.send(JSON.stringify({ id, method, params }));
        } catch (err) {
            finish(reject, err);
        }
    });
}

function normalizeCandidate(item) {
    if (!item || typeof item !== 'object') return null;
    const artifactId = String(item.artifactId || item.artifact_id || '').trim();
    const src = String(item.src || '').trim();
    const naturalWidth = Number(item.naturalWidth ?? item.natural_width ?? 0);
    const naturalHeight = Number(item.naturalHeight ?? item.natural_height ?? 0);
    if (!artifactId || !src) return null;
    return { artifactId, src, naturalWidth, naturalHeight };
}

function candidatesEqual(beforeList, afterList) {
    if (!Array.isArray(beforeList) || !Array.isArray(afterList) || beforeList.length !== afterList.length || beforeList.length === 0) {
        return false;
    }
    return beforeList.every((rawBefore, idx) => {
        const before = normalizeCandidate(rawBefore);
        const after = normalizeCandidate(afterList[idx]);
        return before && after
            && before.artifactId === after.artifactId
            && before.src === after.src
            && before.naturalWidth === after.naturalWidth
            && before.naturalHeight === after.naturalHeight;
    });
}

function buildVerifyProjectionExpression(expectedIdentity) {
    const expectedJson = JSON.stringify(expectedIdentity);
    const originJson = JSON.stringify(GEMINI_ORIGIN);
    return `(() => {
        const module = undefined;
        ${GEMINI_TURN_PROJECTION_EMBED}
        const expected = ${expectedJson};
        if (window.location.origin !== ${originJson}) {
            return { ok: false, reason: 'origin_mismatch' };
        }
        if (!expected || !expected.turn_id || !expected.conversation_id) {
            return { ok: false, reason: 'missing_expected_turn_identity' };
        }
        if (expected.ownership_token && window.__ask_bridge_response_owner_v1 !== expected.ownership_token) {
            return { ok: false, reason: 'ownership_token_mismatch' };
        }
        const conversationId = geminiConversationId(window.location);
        if (conversationId !== expected.conversation_id) {
            return { ok: false, reason: 'conversation_id_mismatch' };
        }
        const isVisible = (el) => {
            if (!el) return false;
            const s = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };
        const stopSelectors = ['button[aria-label*="Stop" i]', 'button[aria-label*="停止"]'];
        const assistantGroups = geminiTurnGroups(document, GEMINI_ASSISTANT_SELECTOR);
        const userGroups = geminiTurnGroups(document, GEMINI_USER_SELECTOR);
        const latestGroup = assistantGroups[assistantGroups.length - 1] || null;
        if (isGeminiGenerating(document, latestGroup, stopSelectors, isVisible)) {
            return { ok: false, reason: 'still_generating' };
        }
        if (expected.user_count && userGroups.length !== expected.user_count) {
            return { ok: false, reason: 'user_count_changed' };
        }
        if (expected.assistant_count && assistantGroups.length !== expected.assistant_count) {
            return { ok: false, reason: 'assistant_count_changed' };
        }
        const id = geminiTurnIdentity(latestGroup);
        if (!id.turnId || id.turnId !== expected.turn_id) {
            return { ok: false, reason: 'turn_id_mismatch' };
        }
        if (Array.isArray(expected.artifact_ids) && expected.artifact_ids.length > 0) {
            const expectedArts = [...expected.artifact_ids].sort().join('|');
            const actualArts = [...id.artifactIds].sort().join('|');
            if (expectedArts !== actualArts) {
                return { ok: false, reason: 'artifact_ids_mismatch' };
            }
        }
        const candidates = findGeminiFinalGeneratedImages(latestGroup, ${MINIMUM_IMAGE_DIMENSION});
        if (candidates.length === 0) {
            return { ok: false, reason: 'no_final_images', candidates: [] };
        }
        if (Array.isArray(expected.image_candidates) && expected.image_candidates.length > 0) {
            const exp = expected.image_candidates;
            if (exp.length !== candidates.length || !exp.every((item, i) => {
                const c = candidates[i];
                const eid = String((item && (item.artifact_id || item.artifactId)) || '');
                const esrc = String((item && item.src) || '');
                const ew = Number((item && (item.natural_width ?? item.naturalWidth)) || 0);
                const eh = Number((item && (item.natural_height ?? item.naturalHeight)) || 0);
                return c && c.artifactId === eid && c.src === esrc && c.naturalWidth === ew && c.naturalHeight === eh;
            })) {
                return { ok: false, reason: 'expected_image_candidates_mismatch', candidates };
            }
        }
        return {
            ok: true,
            reason: '',
            turnId: id.turnId,
            conversationId,
            artifactIds: id.artifactIds,
            candidates,
        };
    })()`;
}

async function readBlobDataUrlFromBrowser(ws, blobUrl, maxBytes = MAX_IMAGE_BYTES, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!isAllowedGeminiBlobUrl(blobUrl)) {
        throw new Error(`Blocked untrusted Gemini blob URL: ${blobUrl}`);
    }
    const effectiveTimeoutMs = Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : REQUEST_TIMEOUT_MS);
    let timer;
    const res = await Promise.race([
        callCdp(ws, 'Runtime.evaluate', {
            expression: `(async () => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), ${effectiveTimeoutMs});
                try {
                    const resp = await fetch(${JSON.stringify(blobUrl)}, { redirect: 'error', signal: controller.signal });
                    if (!resp.ok) {
                        throw new Error('Blob fetch failed with status ' + resp.status);
                    }
                    const rawLen = resp.headers && resp.headers.get ? resp.headers.get('content-length') : null;
                    if (rawLen !== null) {
                        const declared = Number(rawLen);
                        if (Number.isFinite(declared) && declared > ${maxBytes}) {
                            throw new Error('Blob image exceeds maximum allowed bytes');
                        }
                    }
                    const blob = await resp.blob();
                    const mime = String(blob && blob.type || '').toLowerCase();
                    if (!mime.startsWith('image/')) {
                        throw new Error('Blob payload is not an image MIME type');
                    }
                    if (!blob || blob.size <= 0 || blob.size > ${maxBytes}) {
                        throw new Error('Blob image exceeds maximum allowed bytes');
                    }
                    return await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(String(reader.result || ''));
                        reader.onerror = () => reject(new Error('FileReader blob read failed'));
                        reader.readAsDataURL(blob);
                    });
                } finally {
                    clearTimeout(timer);
                }
            })()`,
            awaitPromise: true,
            returnByValue: true,
        }, effectiveTimeoutMs),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Gemini blob image read timed out')), effectiveTimeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));
    const dataUrl = res && res.result && res.result.value;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        throw new Error('Blob fetch did not produce a valid data:image payload');
    }
    return decodeDataImageUrl(dataUrl, maxBytes);
}

// Supports both `(cdpOrWs, frameId, url, maxBytes, timeoutMs)` and `(ws, url, maxBytes, timeoutMs)`
async function tryReadCachedResourceViaCdp(cdpOrWs, frameIdOrUrl, maybeUrlOrMaxBytes, maybeMaxBytes, maybeTimeoutMs) {
    let frameId;
    let url;
    let maxBytes = MAX_IMAGE_BYTES;
    let timeoutMs = REQUEST_TIMEOUT_MS;

    if (typeof maybeUrlOrMaxBytes === 'string') {
        frameId = frameIdOrUrl;
        url = maybeUrlOrMaxBytes;
        if (Number.isFinite(maybeMaxBytes)) maxBytes = maybeMaxBytes;
        if (Number.isFinite(maybeTimeoutMs)) timeoutMs = maybeTimeoutMs;
    } else {
        url = frameIdOrUrl;
        if (Number.isFinite(maybeUrlOrMaxBytes)) maxBytes = maybeUrlOrMaxBytes;
        if (Number.isFinite(maybeMaxBytes)) timeoutMs = maybeMaxBytes;
    }

    const deadlineAt = Date.now() + Math.max(1, timeoutMs);
    const remainingMs = () => Math.max(1, deadlineAt - Date.now());
    const cdpCall = typeof cdpOrWs.call === 'function'
        ? (method, params) => cdpOrWs.call(method, params)
        : (method, params) => callCdp(cdpOrWs, method, params, remainingMs());
    const raceWithRemaining = (promise, msg) => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
            return Promise.reject(new Error(msg));
        }
        let timer;
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(msg)), remaining);
            }),
        ]).finally(() => clearTimeout(timer));
    };

    if (!frameId) {
        const tree = await raceWithRemaining(cdpCall('Page.getResourceTree'), 'Gemini cached resource lookup timed out');
        frameId = tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
    }

    if (!frameId || !url) return null;
    try {
        const cached = await raceWithRemaining(
            cdpCall('Page.getResourceContent', { frameId, url }),
            'Gemini cached resource lookup timed out',
        );
        if (!cached || typeof cached.content !== 'string') return null;
        let buf;
        if (cached.base64Encoded) {
            const rawLen = cached.content.length;
            const padding = cached.content.endsWith('==') ? 2 : (cached.content.endsWith('=') ? 1 : 0);
            const estimated = Math.ceil((rawLen * 3) / 4) - padding;
            if (estimated > maxBytes) {
                throw new Error('Cached CDP image exceeds maximum allowed bytes before decode');
            }
            buf = Buffer.from(cached.content, 'base64');
        } else {
            const byteLen = Buffer.byteLength(cached.content, 'utf8');
            if (byteLen > maxBytes) {
                throw new Error('Cached CDP image exceeds maximum allowed bytes');
            }
            buf = Buffer.from(cached.content, 'utf8');
        }
        if (buf.length > maxBytes) {
            throw new Error('Cached CDP image exceeds maximum allowed bytes');
        }
        const ext = sniffImageExt(buf);
        if (!ext) return null;
        return { ext, source: 'cdp_cached_resource', buffer: buf };
    } catch (err) {
        if (err && (/maximum allowed bytes/i.test(err.message) || /timed out/i.test(err.message))) {
            throw err;
        }
        return null;
    }
}

async function downloadAndPublishBatch(ws, before, verifyExpr, outputArgValue, deps = {}) {
    const readBlobFn = deps.readBlobDataUrlFromBrowser || readBlobDataUrlFromBrowser;
    const readCachedFn = deps.tryReadCachedResourceViaCdp || tryReadCachedResourceViaCdp;
    const fetchFn = deps.fetchWithValidatedRedirects || fetchWithValidatedRedirects;
    const fsOps = deps.fsOps || fs;

    const perImageTimeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : REQUEST_TIMEOUT_MS;
    const verifyTimeoutMs = Number.isFinite(deps.verifyTimeoutMs) ? deps.verifyTimeoutMs : CDP_CALL_TIMEOUT_MS;
    const fetched = [];
    for (let i = 0; i < before.candidates.length; i += 1) {
        const candidate = before.candidates[i];
        const src = candidate.src;
        const imageDeadlineAt = Date.now() + Math.max(1, perImageTimeoutMs);
        const remainingForImage = () => {
            const rem = imageDeadlineAt - Date.now();
            if (rem <= 0) {
                throw new Error('Gemini image request timed out');
            }
            return rem;
        };
        let buffer;

        if (src.startsWith('data:image/')) {
            const decoded = decodeDataImageUrl(src, MAX_IMAGE_BYTES);
            buffer = decoded.buffer;
        } else if (src.startsWith('blob:')) {
            const decoded = await readBlobFn(ws, src, MAX_IMAGE_BYTES, remainingForImage());
            buffer = decoded.buffer;
        } else if (src.startsWith('https://')) {
            assertAllowedGeminiImageHost(src);
            const cached = await readCachedFn(ws, src, MAX_IMAGE_BYTES, remainingForImage());
            if (cached && cached.buffer && cached.buffer.length > 0) {
                buffer = cached.buffer;
            } else {
                const res = await fetchFn(src, { timeoutMs: remainingForImage() });
                buffer = res.buffer;
            }
        } else {
            throw new Error(`Unsupported or insecure Gemini image URL scheme: ${src}`);
        }

        if (!buffer || buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
            throw new Error('Downloaded Gemini image had invalid size');
        }
        const ext = sniffImageExt(buffer);
        if (!ext) {
            throw new Error('Downloaded bytes failed image signature verification');
        }
        fetched.push({ ext, buffer });
    }

    const targetPaths = resolveOutputFilePaths(outputArgValue, fetched.map((f) => f.ext));
    const tempFiles = [];
    try {
        // Phase 1: Stage entire batch to exclusive 0600 temp files + fsync (never touching targetPaths yet).
        for (let i = 0; i < fetched.length; i += 1) {
            const targetPath = targetPaths[i];
            const parentDir = path.dirname(targetPath);
            fs.mkdirSync(parentDir, { recursive: true });
            const tmpPath = writeTempPrivateFile(parentDir, path.basename(targetPath), fetched[i].buffer);
            tempFiles.push({ tmpPath, targetPath });
        }

        // Phase 2: Final post-download verification of turn & image candidates before publishing any file.
        const afterRes = await callCdp(ws, 'Runtime.evaluate', {
            expression: verifyExpr,
            returnByValue: true,
        }, verifyTimeoutMs);
        const after = afterRes && afterRes.result && afterRes.result.value;
        if (!after || !after.ok || !candidatesEqual(before.candidates, after.candidates)) {
            const err = new Error(`Response identity changed during Gemini download: ${(after && after.reason) || 'candidates_mismatch'}`);
            err.exitCode = 2;
            throw err;
        }

        // Phase 3: Pre-validate all targets, back up existing regular files, then atomically publish.
        const backups = [];
        const createdNewTargets = [];
        const existingTargets = [];
        for (const item of tempFiles) {
            let st = null;
            try {
                st = fsOps.lstatSync(item.targetPath);
            } catch (statErr) {
                if (!statErr || statErr.code !== 'ENOENT') {
                    throw statErr;
                }
            }
            if (st !== null) {
                if (st.isDirectory() || st.isSymbolicLink() || !st.isFile()) {
                    const err = new Error(`Refusing to overwrite non-regular target path: ${item.targetPath}`);
                    err.code = st.isDirectory() ? 'EISDIR' : 'EINVAL';
                    throw err;
                }
                existingTargets.push(item.targetPath);
            }
        }

        const existingSet = new Set(existingTargets);
        const published = [];
        try {
            for (const targetPath of existingTargets) {
                const backupPath = path.join(
                    path.dirname(targetPath),
                    `.${path.basename(targetPath)}.bak-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
                );
                fsOps.renameSync(targetPath, backupPath);
                backups.push({ targetPath, backupPath });
            }
            for (const item of tempFiles) {
                fsOps.renameSync(item.tmpPath, item.targetPath);
                item.published = true;
                if (!existingSet.has(item.targetPath)) {
                    createdNewTargets.push(item.targetPath);
                }
                published.push(item.targetPath);
            }
        } catch (publishErr) {
            const rollbackFailures = [];
            const remainingBackups = [];
            const uncleanedNewTargets = [];
            for (const newTarget of createdNewTargets) {
                try {
                    fsOps.unlinkSync(newTarget);
                } catch (error) {
                    rollbackFailures.push({ action: 'unlink_new_target', targetPath: newTarget, error });
                    uncleanedNewTargets.push(newTarget);
                }
            }
            for (let i = backups.length - 1; i >= 0; i -= 1) {
                const b = backups[i];
                try {
                    fsOps.renameSync(b.backupPath, b.targetPath);
                } catch (error) {
                    const failure = {
                        action: 'restore_backup',
                        targetPath: b.targetPath,
                        backupPath: b.backupPath,
                        error,
                    };
                    rollbackFailures.push(failure);
                    remainingBackups.push(failure);
                }
            }
            if (rollbackFailures.length > 0) {
                const retainedBackups = remainingBackups.map((item) => `${item.backupPath} -> ${item.targetPath}`).join(', ') || 'none';
                const uncleanedTargets = uncleanedNewTargets.join(', ') || 'none';
                const err = new Error(
                    `Gemini image publish failed and rollback was incomplete; remaining backups: ${retainedBackups}; uncleaned targets: ${uncleanedTargets}; original error: ${publishErr && publishErr.message ? publishErr.message : String(publishErr)}`,
                );
                err.publishError = publishErr;
                err.rollbackFailures = rollbackFailures;
                err.remainingBackups = remainingBackups;
                err.uncleanedNewTargets = uncleanedNewTargets;
                throw err;
            }
            throw publishErr;
        }
        for (const b of backups) {
            try { fsOps.unlinkSync(b.backupPath); } catch (_) {}
        }
        return published;
    } catch (err) {
        for (const item of tempFiles) {
            if (!item.published) {
                try { fsOps.unlinkSync(item.tmpPath); } catch (_) {}
            }
        }
        throw err;
    }
}

async function readExpectedIdentityPayload(rawArg) {
    if (rawArg !== '-') {
        return rawArg;
    }
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

function waitForWebSocketOpen(ws, timeoutMs = CDP_OPEN_TIMEOUT_MS) {
    if (!ws || typeof ws.addEventListener !== 'function') {
        return Promise.reject(new Error('Invalid CDP WebSocket'));
    }
    if (ws.readyState === 1) return Promise.resolve();
    const effectiveTimeoutMs = Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : CDP_OPEN_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const cleanup = () => {
            if (typeof ws.removeEventListener === 'function') {
                ws.removeEventListener('open', onOpen);
                ws.removeEventListener('error', onError);
                ws.removeEventListener('close', onClose);
            }
            if (timer !== null) clearTimeout(timer);
        };
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
        };
        const onOpen = () => finish(resolve);
        const onError = () => finish(reject, new Error('CDP connection failed'));
        const onClose = () => finish(reject, new Error('CDP connection closed before open'));
        ws.addEventListener('open', onOpen);
        ws.addEventListener('error', onError);
        ws.addEventListener('close', onClose);
        timer = setTimeout(() => finish(reject, new Error('CDP connection open timed out')), effectiveTimeoutMs);
    });
}

function writeStreamFlushed(stream, value) {
    return new Promise((resolve, reject) => {
        if (!stream || typeof stream.write !== 'function') {
            resolve();
            return;
        }
        let settled = false;
        const finish = (err) => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve();
        };
        try {
            stream.write(value, (err) => finish(err));
        } catch (err) {
            finish(err);
        }
    });
}

async function runCli(deps = {}) {
    const token = deps.tokenArg ?? tokenArg;
    const output = deps.outputArg ?? outputArg;
    const identityArg = deps.expectedIdentityJsonArg ?? expectedIdentityJsonArg;
    const fetchImpl = deps.fetch || fetch;
    const WebSocketCtor = deps.WebSocketCtor || WebSocket;
    const perImageTimeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : REQUEST_TIMEOUT_MS;
    const verifyTimeoutMs = Number.isFinite(deps.verifyTimeoutMs) ? deps.verifyTimeoutMs : CDP_CALL_TIMEOUT_MS;
    const cleanupTimeoutMs = Number.isFinite(deps.cleanupTimeoutMs) ? deps.cleanupTimeoutMs : 2000;
    const configuredOverallLimitMs = Number.isFinite(deps.overallLimitMs) && deps.overallLimitMs > 0
        ? deps.overallLimitMs
        : null;
    const onWatchdogExit = typeof deps.onWatchdogExit === 'function'
        ? deps.onWatchdogExit
        : () => process.exit(1);
    const writeStdout = typeof deps.writeStdout === 'function'
        ? deps.writeStdout
        : (value) => writeStreamFlushed(process.stdout, value);
    let deadline = setTimeout(onWatchdogExit, configuredOverallLimitMs || 45000);
    let ws = null;
    try {
        if (!token || !output || !identityArg) {
            throw new Error('Invalid Gemini download arguments');
        }

        const expectedIdentityRaw = await readExpectedIdentityPayload(identityArg);
        let expectedIdentity;
        try {
            expectedIdentity = JSON.parse(expectedIdentityRaw);
        } catch (_) {
            throw new Error('Invalid expected identity payload');
        }
        if (
            !expectedIdentity
            || typeof expectedIdentity !== 'object'
            || typeof expectedIdentity.turn_id !== 'string'
            || !expectedIdentity.turn_id.trim()
            || typeof expectedIdentity.conversation_id !== 'string'
            || !expectedIdentity.conversation_id.trim()
        ) {
            throw new Error('Gemini image download requires non-empty verified turn_id and conversation_id');
        }

        const pages = await (await fetchImpl('http://127.0.0.1:9223/json/list')).json();
        const matched = [];
        for (const page of (Array.isArray(pages) ? pages : []).filter((p) => {
            if (!p || p.type !== 'page' || typeof p.url !== 'string') return false;
            try { return new URL(p.url).origin === GEMINI_ORIGIN; } catch (_) { return false; }
        })) {
            const candidateWs = new WebSocketCtor(page.webSocketDebuggerUrl);
            try {
                await waitForWebSocketOpen(candidateWs, CDP_OPEN_TIMEOUT_MS);
                const marker = await callCdp(candidateWs, 'Runtime.evaluate', {
                    expression: 'window.__ask_bridge_download_token || window.__ask_bridge_gemini_download_token',
                    returnByValue: true,
                }, CDP_CALL_TIMEOUT_MS);
                if (marker && marker.result && marker.result.value === token) {
                    matched.push({ page, ws: candidateWs });
                } else {
                    candidateWs.close();
                }
            } catch (_) {
                try { candidateWs.close(); } catch (_) {}
            }
        }

        if (matched.length !== 1) {
            for (const item of matched) {
                try { item.ws.close(); } catch (_) {}
            }
            throw new Error('Owned Gemini download target was not unique');
        }

        ws = matched[0].ws;
        await callCdp(ws, 'Page.enable', {}, CDP_CALL_TIMEOUT_MS);

        const verifyExpr = buildVerifyProjectionExpression(expectedIdentity);
        const beforeRes = await callCdp(ws, 'Runtime.evaluate', {
            expression: verifyExpr,
            returnByValue: true,
        }, CDP_CALL_TIMEOUT_MS);
        const before = beforeRes && beforeRes.result && beforeRes.result.value;
        if (!before || !before.ok) {
            const err = new Error(`Response identity mismatch before Gemini download: ${(before && before.reason) || 'unknown'}`);
            err.exitCode = 2;
            throw err;
        }

        if (configuredOverallLimitMs === null) {
            clearTimeout(deadline);
            deadline = setTimeout(onWatchdogExit, Math.max(35000, before.candidates.length * perImageTimeoutMs + 15000));
        }

        const savedFiles = await downloadAndPublishBatch(ws, before, verifyExpr, output, {
            timeoutMs: perImageTimeoutMs,
            verifyTimeoutMs,
            fsOps: deps.fsOps,
        });
        await writeStdout(JSON.stringify({ ok: true, count: savedFiles.length, files: savedFiles }));
    } catch (error) {
        const hasRemainingBackups = Array.isArray(error && error.remainingBackups)
            && error.remainingBackups.length > 0;
        const hasUncleanedTargets = Array.isArray(error && error.uncleanedNewTargets)
            && error.uncleanedNewTargets.length > 0;
        if (hasRemainingBackups || hasUncleanedTargets) {
            await writeStdout(JSON.stringify({
                ok: false,
                error: 'publish_rollback_incomplete',
                remaining_backups: (error.remainingBackups || []).map((item) => ({
                    target_path: String((item && item.targetPath) || ''),
                    backup_path: String((item && item.backupPath) || ''),
                })),
                uncleaned_targets: (error.uncleanedNewTargets || []).map((value) => String(value || '')),
            }));
        }
        throw error;
    } finally {
        if (ws) {
            try {
                await callCdp(ws, 'Runtime.evaluate', {
                    expression: 'delete window.__ask_bridge_download_token; delete window.__ask_bridge_gemini_download_token',
                }, cleanupTimeoutMs);
            } catch (_) {}
            try { ws.close(); } catch (_) {}
        }
        clearTimeout(deadline);
    }
}

module.exports = {
    GEMINI_ORIGIN,
    MAX_IMAGE_BYTES,
    MAX_REDIRECTS,
    REQUEST_TIMEOUT_MS,
    CDP_CALL_TIMEOUT_MS,
    CDP_OPEN_TIMEOUT_MS,
    DEFAULT_MINIMUM_IMAGE_DIMENSION,
    MINIMUM_IMAGE_DIMENSION,
    GEMINI_TURN_PROJECTION_EMBED,
    isAllowedGeminiImageHost,
    isAllowedGeminiImageUrl,
    isAllowedGeminiBlobUrl,
    assertAllowedGeminiImageHost,
    isPrivateOrLoopbackIp,
    decodeDataImageUrl,
    resolveAndValidatePublicAddress,
    fetchWithValidatedRedirects,
    downloadWithManualRedirects,
    tryReadCachedResourceViaCdp,
    writeTempPrivateFile,
    atomicWritePrivateFile,
    resolveOutputFilePaths,
    downloadAndPublishBatch,
    readBlobDataUrlFromBrowser,
    readExpectedIdentityPayload,
    sniffImageExt,
    candidatesEqual,
    buildVerifyProjectionExpression,
    callCdp,
    writeStreamFlushed,
    runCli,
};

if (process.env.ASK_BRIDGE_DOWNLOAD_NO_AUTORUN !== '1') {
    runCli()
        .then(() => {
            process.exitCode = 0;
        })
        .catch(async (error) => {
            const code = error && Number.isInteger(error.exitCode) ? error.exitCode : 1;
            process.exitCode = code;
            try {
                await writeStreamFlushed(
                    process.stderr,
                    `${error && error.message ? error.message : 'Gemini CDP download failed'}\n`,
                );
            } catch (_) {}
            const forceExit = setTimeout(() => process.exit(code), 1000);
            if (typeof forceExit.unref === 'function') {
                forceExit.unref();
            }
        });
}
