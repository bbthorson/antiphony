/**
 * Number of trusted reverse-proxy hops the platform appends to the RIGHT of
 * `X-Forwarded-For`.
 *
 * Firebase App Hosting fronts Cloud Run with a Google external Application Load
 * Balancer (GFE). Per Google's external ALB contract the edge appends
 * `<client-ip>,<GFE-ip>`, so the GFE is the LAST entry and the real client is
 * one hop in from the right.
 *
 * Confirmed empirically (June 2026 H5 investigation — see
 * `docs/security-audit-2026-06.md`): EVERY Cloud Run request-log `remoteIp`
 * for the `vox-pop-core-api` backend is a Google GFE address in
 * `192.178.13.0/24`. That is the peer Cloud Run sees — i.e. the rightmost XFF
 * entry is Google infrastructure, never the client. The previous code took the
 * rightmost entry, so all traffic collapsed into rotating Google-infra buckets,
 * neutering per-IP rate limiting and the pending-upload `ipHash` abuse signal.
 *
 * VERIFY AFTER DEPLOY: the diagnostic log in `rate-limit.ts` emits the raw
 * chain + chosen IP. Make one request from a known IP and confirm `clientIp`
 * matches it. If App Hosting adds an extra app-visible hop, bump this to 2.
 */
const TRUSTED_PROXY_HOPS = 1;

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
