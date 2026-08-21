/**
 * Number of trusted reverse-proxy hops the platform appends to the RIGHT of
 * `X-Forwarded-For`. THIS IS TOPOLOGY-DEPENDENT — it must be re-measured
 * whenever the edge in front of this service changes. It has now been wrong
 * twice, both times silently, and both times the symptom was one shared
 * rate-limit bucket rather than an error.
 *
 * ── Current: Cloudflare → Google frontend → Cloud Run — 1 hop ────────────────
 * Measured 2026-08-09, immediately after the App Hosting → Cloud Run cutover,
 * by hitting the same anonymous route through both paths and comparing the
 * chain length the `rate-limit.ts` warn reports:
 *
 *     via api.antiphony.dev  ->  <client-ip>, <cloudflare-egress-ip>   (2 entries)
 *     direct to *.run.app    ->  <client-ip>                           (1 entry)
 *
 * Cloudflare adds exactly one entry over the direct path, so the client is ONE
 * hop in from the right. Note the direct `*.run.app` URL is publicly reachable
 * and bypasses Cloudflare entirely; such a request yields a 1-entry chain,
 * `idx` of -1, and therefore 'unknown' — unbucketed, but fail-safe rather than
 * spoofable.
 *
 * ── Previous: Firebase App Hosting — 2 hops ─────────────────────────────────
 * Retired 2026-08-09. Kept because the default below is still 2, and because
 * it is the shape `client-ip.test.ts` asserts against:
 *
 *     <client-ip>, <GCLB-ip 35.219.x>, <GFE-ip 192.178.13.x>           (3 entries)
 *
 * That earlier calibration also started as an off-by-one — 1 hop bucketed every
 * caller on the stable `35.219.x` GCLB address, i.e. one shared rate-limit
 * bucket for the entire internet, which is how it was caught the first time.
 *
 * Set via `TRUSTED_PROXY_HOPS` in deploy/cloudrun.env.yaml, so a topology change
 * is correctable without a code deploy. The default stays 2 rather than tracking
 * whatever this deployment happens to run: self-hosters on App Hosting are the
 * ones relying on the fallback, and the hosted deploy sets the value explicitly.
 *
 * The detector is the `warn` in `rate-limit.ts`: if the platform changes its hop
 * count, the entry this indexes to falls outside the chain and extraction
 * collapses to 'unknown' despite an XFF header being present. That is exactly
 * what fired after the cutover. Falls back to 2 when unset or non-numeric.
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
 * ── Why this exists: the THIRD silent collapse ───────────────────────────────
 * The `TRUSTED_PROXY_HOPS` note above says the hop count "has now been wrong
 * twice, both times silently, and both times the symptom was one shared
 * rate-limit bucket rather than an error." This is the third, and it is not a
 * hop count at all: this service became a **Cloudflare Worker**, and the
 * Cloudflare edge does not send `X-Forwarded-For` to a Worker. There is no
 * chain, so no offset can be right.
 *
 * `extractClientIp` returned 'unknown' for every request on the service, and
 * 'unknown' is a real bucket, so `write` (10 per 15 min) applied to the whole
 * platform at once. Diagnosed 2026-08-21 from the consuming side: prompts
 * published through the Vox Pop BFF started failing with a relayed 429 on the
 * first attempt of a session, because a handful of ordinary reads had already
 * spent the shared bucket.
 *
 * Note what did NOT fire: the `warn` in `rate-limit.ts` that the block above
 * nominates as "the detector" is guarded on `ip === 'unknown' && xff`, i.e. on
 * a chain that is present but unresolvable. With XFF absent entirely the alarm
 * built for exactly this failure could not ring. That guard is dropped in this
 * change.
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
