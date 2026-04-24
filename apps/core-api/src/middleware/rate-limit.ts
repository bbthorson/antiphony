import type { MiddlewareHandler } from 'hono';
import { getAdminDb, getAdmin } from '../lib/firebase-admin.js';
import { logger } from '../lib/logger.js';

/**
 * Rate-limit middleware. Hono port of `apps/web/src/lib/api/rate-limit.ts`.
 *
 * Firestore-backed, IP-keyed, with a circuit breaker that fails open after
 * 5 consecutive Firestore errors (30s cooldown). Writes to the same
 * `rate_limits` collection apps/web uses — per spec Post-4a Follow-ups,
 * we'll split collections per backend after 4a stabilizes.
 *
 * Presets match apps/web for contract parity:
 *   write / read / auth / hourly / sensitive / burst / standard
 *
 * IP extraction takes the **rightmost** `X-Forwarded-For` entry — that's
 * the IP the trusted reverse proxy added; earlier entries can be spoofed
 * by the client. Private/loopback IPs are rejected so they can't
 * share a single rate-limit bucket.
 */

export interface RateLimitOptions {
    limit: number;
    windowMs: number;
    message?: string;
}

export const RATE_LIMITS = {
    /** Create/update operations (10 per 15 min). */
    write: { limit: 10, windowMs: 15 * 60 * 1000 } satisfies RateLimitOptions,
    /** Read/list operations (60 per min). */
    read: { limit: 60, windowMs: 60 * 1000 } satisfies RateLimitOptions,
    /** Auth-sensitive operations (5 per min). */
    auth: { limit: 5, windowMs: 60 * 1000 } satisfies RateLimitOptions,
    /** Uploads, deletes, maintenance tasks (20 per hour). */
    hourly: { limit: 20, windowMs: 60 * 60 * 1000 } satisfies RateLimitOptions,
    /** High-impact operations: org creation, AI generation (5 per hour). */
    sensitive: { limit: 5, windowMs: 60 * 60 * 1000 } satisfies RateLimitOptions,
    /** Frequent writes: session management, autosave (20 per min). */
    burst: { limit: 20, windowMs: 60 * 1000 } satisfies RateLimitOptions,
    /** Moderate operations: RSS imports (10 per min). */
    standard: { limit: 10, windowMs: 60 * 1000 } satisfies RateLimitOptions,
} as const;

function extractClientIp(xff: string | undefined): string {
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

// Circuit breaker state — module-scoped intentionally so it persists across
// requests within the same Cloud Run instance.
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 30_000;

/**
 * Build a rate-limit middleware with the given options. Call per-route:
 *
 *   app.get('/api/v1/handles', rateLimit(RATE_LIMITS.read), async (c) => { ... })
 */
export const rateLimit = (options: RateLimitOptions, customKey?: string): MiddlewareHandler => {
    return async (c, next) => {
        // Circuit breaker: Firestore is failing; fail open.
        if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
            if (Date.now() < circuitOpenUntil) {
                logger.warn({ requestId: c.get('requestId') }, '[rate-limit] circuit open — skipping');
                return next();
            }
            consecutiveFailures = CIRCUIT_FAILURE_THRESHOLD - 1;
        }

        const ip = extractClientIp(c.req.header('x-forwarded-for'));
        const key = `ratelimit_${customKey || ip}`;
        const db = getAdminDb();
        const admin = getAdmin();
        const docRef = db.collection('rate_limits').doc(key);
        const now = Date.now();

        try {
            const isLimited = await db.runTransaction(async (t) => {
                const doc = await t.get(docRef);
                const data = doc.data();

                if (!doc.exists || (data && now > data.resetTime)) {
                    const resetTime = now + options.windowMs;
                    // expiresAt: Firestore Timestamp for TTL auto-deletion,
                    // 1 hour after window close (buffer for in-flight reqs).
                    const expiresAt = admin.firestore.Timestamp.fromMillis(resetTime + 60 * 60 * 1000);
                    t.set(docRef, { count: 1, resetTime, expiresAt });
                    return false;
                }
                if (data && data.count >= options.limit) {
                    return true;
                }
                t.update(docRef, { count: (data?.count ?? 0) + 1 });
                return false;
            });

            consecutiveFailures = 0;

            if (isLimited) {
                logger.warn({ requestId: c.get('requestId'), key, limit: options.limit }, '[rate-limit] exceeded');
                return c.json(
                    {
                        status: 'error',
                        message: options.message || 'Too many requests',
                        requestId: c.get('requestId'),
                    },
                    429,
                );
            }
        } catch (error: unknown) {
            consecutiveFailures++;
            if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
                circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
                logger.error(
                    { error, cooldownMs: CIRCUIT_COOLDOWN_MS },
                    `[rate-limit] circuit opened after ${CIRCUIT_FAILURE_THRESHOLD} failures`,
                );
            } else {
                logger.error({ error }, '[rate-limit] firestore error');
            }
            // Fail-open on Firestore errors — don't block legitimate traffic
            // on a Firestore hiccup.
        }

        return next();
    };
};
