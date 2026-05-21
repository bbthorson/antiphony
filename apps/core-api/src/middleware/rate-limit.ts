import type { MiddlewareHandler } from 'hono';
import { getAdminDb, getAdmin } from '../lib/firebase-admin.js';
import { extractClientIp } from '../lib/client-ip.js';
import { logger } from '../lib/logger.js';
import { errorEnvelope } from '../lib/error-envelope.js';

/**
 * Rate-limit middleware. Hono port of `apps/web/src/lib/api/rate-limit.ts`.
 *
 * Firestore-backed, IP-keyed, with a circuit breaker that fails open after
 * 5 consecutive *systemic* Firestore errors (30s cooldown). Per-bucket
 * transaction contention (ABORTED / FAILED_PRECONDITION) fails CLOSED:
 * returns 429 rather than letting the request through. See the catch block
 * below for the rationale. Writes to the same `rate_limits` collection
 * apps/web uses — per spec Post-4a Follow-ups, we'll split collections per
 * backend after 4a stabilizes.
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
                    errorEnvelope(c, options.message || 'Too many requests'),
                    429,
                );
            }
        } catch (error: unknown) {
            // Discriminate between "systemic failure" (Firestore is down; trip
            // the circuit) and "per-request contention" (concurrent writes on
            // the SAME rate-limit bucket — e.g. one hot IP). Per-request errors
            // must NOT increment the global counter, or a single aggressive
            // caller could trip the circuit and fail-open rate limiting for
            // everyone by hammering their own bucket.
            //
            // Firestore grpc error codes:
            //   - ABORTED (10): transaction conflict / contention — per-bucket, expected
            //     under concurrent load on the same doc. Don't count.
            //   - FAILED_PRECONDITION (9): stale data in transaction — same, per-bucket.
            //   - DEADLINE_EXCEEDED (4): could be systemic OR contention timeout.
            //     Treat as systemic (rare enough it's not worth tolerating silently).
            //   - Everything else (UNAVAILABLE, INTERNAL, UNAUTHENTICATED, etc.): systemic.
            //
            // The `code` field is set by @google-cloud/firestore error types;
            // we check it structurally rather than importing the full error
            // type because the Admin SDK's error hierarchy isn't exported.
            const code = (error as { code?: number | string } | null)?.code;
            const isPerRequest = code === 10 || code === 'ABORTED' || code === 9 || code === 'FAILED_PRECONDITION';

            if (isPerRequest) {
                // Per-bucket contention: the Firestore Admin SDK already retried
                // the transaction internally before this error bubbled up. Getting
                // ABORTED here means many concurrent writers on the SAME bucket
                // — which is exactly what the rate limit is supposed to catch.
                // Fail CLOSED: return 429 rather than letting the request through.
                //
                // Trade-off: legitimate bursts from shared-NAT IPs (corporate VPNs)
                // will get 429s under contention. That's acceptable — they ARE
                // exceeding the per-IP rate, and the alternative is letting
                // attackers bypass the limiter by simply hammering one bucket.
                //
                // Not counted toward the systemic circuit breaker, since this is
                // expected per-bucket behavior, not a Firestore-wide failure.
                logger.warn(
                    { error, requestId: c.get('requestId'), key },
                    '[rate-limit] transaction contention on bucket — failing closed (429)',
                );
                return c.json(
                    errorEnvelope(c, options.message || 'Too many requests'),
                    429,
                );
            }

            consecutiveFailures++;
            if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
                circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
                logger.error(
                    { error, cooldownMs: CIRCUIT_COOLDOWN_MS },
                    `[rate-limit] circuit opened after ${CIRCUIT_FAILURE_THRESHOLD} systemic failures`,
                );
            } else {
                logger.error({ error }, '[rate-limit] firestore systemic error');
            }
            // Fail-OPEN on systemic Firestore errors — a Firestore outage
            // shouldn't take the whole API down. Per-bucket contention is
            // handled above and fails closed.
        }

        return next();
    };
};
