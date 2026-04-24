/**
 * Extract the client IP from the `X-Forwarded-For` header. Takes the
 * rightmost entry — that's the IP the trusted reverse proxy added;
 * earlier entries can be spoofed by the client.
 *
 * Private/loopback ranges collapse to `'unknown'` so they can't share
 * a single rate-limit bucket or inflate a single ipHash abuse signature.
 *
 * Single source of truth — used by both the rate-limit middleware and
 * the pending-uploads route. Previously duplicated in both locations
 * with the pending-uploads copy missing the private-IP filter.
 */
export function extractClientIp(xff: string | undefined): string {
    if (!xff) return 'unknown';
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    const ip = parts[parts.length - 1] || 'unknown';

    if (
        ip === 'unknown' ||
        ip.startsWith('10.') ||
        ip.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
        ip === '127.0.0.1' ||
        ip === '::1' ||
        ip === 'localhost'
    ) {
        return 'unknown';
    }
    return ip;
}
