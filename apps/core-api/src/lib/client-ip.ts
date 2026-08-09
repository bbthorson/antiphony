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
const TRUSTED_PROXY_HOPS = (() => {
    const raw = Number(process.env.TRUSTED_PROXY_HOPS);
    return Number.isInteger(raw) && raw >= 0 ? raw : 2;
})();

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
 * Extract the client IP from the `X-Forwarded-For` header.
 *
 * Takes the entry `TRUSTED_PROXY_HOPS` positions in from the right — the IP the
 * trusted Google edge recorded for the connecting client. Entries further left
 * are client-supplied and therefore spoofable; the rightmost is the GFE itself.
 *
 * Single source of truth — used by the rate-limit middleware and the
 * pending-uploads route.
 */
export function extractClientIp(xff: string | undefined): string {
    if (!xff) return 'unknown';
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);

    // The chain must contain at least the client + the trusted proxy hop(s).
    // A shorter chain means the request didn't traverse the expected edge
    // (local/dev, or a misrouted request) — fail safe to 'unknown' rather than
    // trust a potentially client-spoofed single value.
    const idx = parts.length - 1 - TRUSTED_PROXY_HOPS;
    const ip = idx >= 0 ? normalizeIp(parts[idx]) : 'unknown';

    return isNonRoutable(ip) ? 'unknown' : ip;
}
