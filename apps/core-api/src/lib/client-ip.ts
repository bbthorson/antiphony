/**
 * Number of trusted reverse-proxy hops the platform appends to the RIGHT of
 * `X-Forwarded-For`.
 *
 * Firebase App Hosting fronts Cloud Run with **two** Google infrastructure hops,
 * confirmed empirically from production XFF chains (June 2026 H5 investigation —
 * see `docs/security-audit-2026-06.md`). Every chain on the `vox-pop-core-api`
 * backend has the exact shape:
 *
 *     <client-ip>, <GCLB-ip 35.219.x>, <GFE-ip 192.178.13.x>
 *
 * The two rightmost entries are Google's load balancer and front-end (both
 * public Google ranges, so they can't be filtered by an is-private check); the
 * real client is the entry TWO hops in from the right. The original H5 fix used
 * 1 hop and so bucketed on the stable `35.219.x` GCLB IP — the diagnostic log in
 * `rate-limit.ts` showed `clientIp: 35.219.200.199` for every request, which is
 * how we caught it. With 2 hops the client is correctly extracted, and a client
 * that spoofs a leading XFF entry is ignored (we trust only what the edge
 * appended).
 *
 * Overridable via the `TRUSTED_PROXY_HOPS` env var (apphosting.yaml) so a future
 * platform topology change can be corrected without a code deploy — the
 * diagnostic log in `rate-limit.ts` is the detector (if `clientIp` starts
 * showing a Google infra IP or `unknown`, the hop count moved). Falls back to 2
 * when unset or non-numeric.
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
