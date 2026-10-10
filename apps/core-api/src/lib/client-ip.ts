/**
 * Number of trusted reverse-proxy hops the platform appends to the RIGHT of
 * `X-Forwarded-For`. Used only on the XFF path — the hosted deployment is a
 * Cloudflare Worker and reads `CF-Connecting-IP` instead (`CLIENT_IP_SOURCE`,
 * below), so this matters to a self-hoster who fronts the API with a proxy
 * that does send XFF.
 *
 * THIS IS TOPOLOGY-DEPENDENT — measure it for the proxy chain actually in
 * front of the service. Getting it wrong is silent: the symptom is one shared
 * rate-limit bucket, not an error. Each proxy you trust adds one entry, so with
 * N trusted hops the client address is N entries in from the right; anything
 * further left is client-supplied and spoofable. A chain too short for the
 * configured count yields 'unknown' — unbucketed, but fail-safe rather than
 * spoofable.
 *
 * Example (a CDN in front of a load balancer — 2 hops):
 *
 *     <client-ip>, <cdn-ip>, <load-balancer-ip>           (3 entries)
 *
 * An off-by-one in the other direction is worse than it looks: one hop too few
 * buckets every caller on a stable proxy address, i.e. one shared rate-limit
 * bucket for the entire internet.
 *
 * Set via `TRUSTED_PROXY_HOPS`, so a topology change is correctable without a
 * code deploy. Falls back to 2 when unset or non-numeric. The detector is the
 * `warn` in `rate-limit.ts`: if the hop count is wrong, the entry this indexes
 * to falls outside the chain and extraction collapses to 'unknown' despite an
 * XFF header being present.
 */
function trustedProxyHops(): number {
    const raw = Number(process.env.TRUSTED_PROXY_HOPS);
    return Number.isInteger(raw) && raw >= 0 ? raw : 2;
}

/**
 * Which header carries the client address on this deployment.
 *
 * `'cf'` reads `CF-Connecting-IP`; anything else keeps the XFF path, so an unset
 * or typo'd value fails to the stricter behavior rather than the looser one.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * The Cloudflare edge does not send `X-Forwarded-For` to a Worker. There is no
 * chain, so no hop count can be right.
 *
 * `extractClientIp` returned 'unknown' for every request on the service, and
 * 'unknown' is a real bucket, so `write` (10 per 15 min) applied to the whole
 * platform at once. Diagnosed 2026-08-21 from the consuming side: prompts
 * published through the Vox Pop BFF started failing with a relayed 429 on the
 * first attempt of a session, because a handful of ordinary reads had already
 * spent the shared bucket.
 *
 * The `warn` in `rate-limit.ts` was once guarded on `ip === 'unknown' && xff`,
 * so with XFF absent entirely it could not fire; that guard has been dropped.
 *
 * Read per-request, not at module scope: on workerd a Worker's `vars` reach
 * `process.env` through a polyfill tied to request context, and whether a
 * top-level read sees them depends on when the module first evaluates. Same
 * reason `trustedProxyHops` stopped being a module-scope constant.
 */
function clientIpSource(): 'cf' | 'xff' {
    return process.env.CLIENT_IP_SOURCE === 'cf' ? 'cf' : 'xff';
}

/**
 * Normalize an XFF entry: lowercase, and unwrap an IPv4-mapped IPv6 address
 * (`::ffff:203.0.113.7` → `203.0.113.7`) so the v4 filters + bucket key apply
 * to the embedded address rather than the wrapped form.
 */
function normalizeIp(ip: string): string {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    return mapped ? mapped[1] : lower;
}

/**
 * Private / loopback / reserved ranges collapse to `'unknown'` so they can't
 * share a single rate-limit bucket or inflate a single ipHash abuse signature.
 * Expects an already-normalized (lowercased, v4-unwrapped) address.
 */
function isNonRoutable(ip: string): boolean {
    return (
        ip === 'unknown' ||
        ip === 'localhost' ||
        // IPv4 private (RFC 1918), loopback (127/8), link-local (169.254/16),
        // and "this host" (0/8).
        ip.startsWith('10.') ||
        ip.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
        ip.startsWith('127.') ||
        ip.startsWith('169.254.') ||
        ip.startsWith('0.') ||
        // IPv6 loopback (::1), unique-local (fc00::/7 → fc../fd..) and
        // link-local (fe80::/10 → fe8./fe9./fea./feb.).
        ip === '::1' ||
        ip.startsWith('fc') ||
        ip.startsWith('fd') ||
        /^fe[89ab]/.test(ip)
    );
}

/**
 * Validate one candidate address down to this module's contract: an IPv4/IPv6
 * literal, or `'unknown'`. Shared by both header paths so they cannot drift
 * apart about what counts as an address.
 */
function sanitizeIp(raw: string | null | undefined): string {
    if (!raw) return 'unknown';
    const ip = normalizeIp(raw.trim());
    return isNonRoutable(ip) ? 'unknown' : ip;
}

/**
 * Extract the client IP from the request.
 *
 * On Cloudflare (`CLIENT_IP_SOURCE=cf`) this is `CF-Connecting-IP`. Otherwise it
 * is the entry `TRUSTED_PROXY_HOPS` positions in from the right of
 * `X-Forwarded-For` — the IP the trusted edge recorded for the connecting
 * client. Entries further left are client-supplied and therefore spoofable; the
 * rightmost is the edge itself.
 *
 * Takes the whole `Request` rather than one header string, so the source
 * decision lives here rather than being made for it at each call site.
 *
 * Single source of truth — used by the rate-limit middleware and the
 * pending-uploads route.
 */
export function extractClientIp(req: Request): string {
    if (clientIpSource() === 'cf') {
        // A single address the edge sets and overwrites — no chain, no offset,
        // and nothing a client can prepend to.
        return sanitizeIp(req.headers.get('cf-connecting-ip'));
    }

    const xff = req.headers.get('x-forwarded-for');
    if (!xff) return 'unknown';
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);

    // The chain must contain at least the client + the trusted proxy hop(s).
    // A shorter chain means the request didn't traverse the expected edge
    // (local/dev, or a misrouted request) — fail safe to 'unknown' rather than
    // trust a potentially client-spoofed single value.
    const idx = parts.length - 1 - trustedProxyHops();
    return idx >= 0 ? sanitizeIp(parts[idx]) : 'unknown';
}
