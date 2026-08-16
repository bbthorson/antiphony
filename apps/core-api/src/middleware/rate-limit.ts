import type { MiddlewareHandler } from 'hono';
import { extractClientIp } from '../lib/client-ip.js';
import { ServiceError } from 'shared/errors';
import { logger } from '../lib/logger.js';
import { servicesFor } from '../composition.js';
import type { RateLimitStore } from '../ports/rate-limit-store.js';

/**
 * Rate-limit middleware — IP-keyed, with a circuit breaker that fails open
 * after 5 consecutive *systemic* store failures (30s cooldown).
 *
 * Storage sits behind `RateLimitStore` (ports/rate-limit-store.ts); the policy
 * below does not know what backs it. The split is deliberate and the port file
 * explains it at length, but the short version: whether a bucket is over its
 * limit is the store's question, and what to do when the store cannot answer
 * is the deployment's. Only the first varies by backend.
 *
 * **The asymmetry is the load-bearing part** (rate-limit.test.ts is built
 * around it):
 *
 *   - `unavailable` — the store is systemically unwell. Fail **OPEN** after the
 *     breaker trips: a storage outage must not take the whole API down.
 *   - `over` — refuse. A Firestore binding also reports per-bucket contention
 *     as `over` rather than `unavailable`, so a caller hammering one bucket
 *     cannot trip the breaker and fail-open the limiter for everyone.
 *
 * IP extraction is `extractClientIp` (lib/client-ip.ts), which indexes in from
 * the RIGHT of `X-Forwarded-For` by the trusted hop count — entries further
 * left are client-supplied and spoofable. Private/loopback addresses collapse
 * to 'unknown' so they cannot share one bucket.
 *
 * `checkRateLimit(key, options, requestId?)` is the callable core the
 * middleware wraps. It was also exposed over HTTP at
 * `POST /api/v1/system/rate-limit/check` so a sibling service could share these
 * buckets; that route is gone (the Vox Pop BFF serves its own — Stream 4 F7 G2)
 * and nothing external shares them any more, which is what makes moving them
 * off Firestore a purely internal decision.
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
 * Result of a single rate-limit check. Discriminator is `allowed`:
 *
 *   - `allowed: true` — caller may proceed (under limit, or fail-open
 *     because Firestore is throwing systemic errors and the circuit is
 *     open).
 *   - `allowed: false` — caller is blocked. Two sub-cases:
 *     - The bucket's count met or exceeded `limit` (normal rate-limit hit).
 *     - Per-bucket transaction contention from Firestore (Admin SDK
 *       already retried; getting ABORTED/FAILED_PRECONDITION means many
 *       concurrent writers are hammering the same bucket, which is what
 *       the rate limit is supposed to catch — fail closed).
 *
 * Discrimination is intentionally opaque to callers: they should respond
 * with 429 for any `allowed: false`. Surfacing the sub-reason would invite
 * UI branching on an internal implementation detail.
 */
export interface CheckRateLimitResult {
    allowed: boolean;
}

/**
 * Run a rate-limit check against the `rate_limits/{key}` doc in Firestore.
 *
 * Pure function — no Hono context binding. Used by the `rateLimit(...)`
 * middleware factory below. (It previously also backed
 * `POST /api/v1/system/rate-limit/check`; that route was removed once the BFF
 * began serving its own.)
 *
 * @param key — the bucket id. Typically `ratelimit_<ip>` or a custom key set by
 *              the caller.
 * @param options — limit + windowMs.
 * @param requestId — optional, threaded into log lines so the caller's
 *                    requestId correlates with core-api logs.
 * @param store — REQUIRED, and deliberately has no default. It used to default
 *                to `firebaseRateLimitStore`, and the middleware below never
 *                passed anything — so the Postgres binding from #86 could not
 *                be reached in production by any configuration, and the
 *                Firestore import put `firebase-admin` on the module graph of
 *                every rate-limited route. A required parameter is what stops
 *                that from silently coming back.
 */
export async function checkRateLimit(
    key: string,
    options: RateLimitOptions,
    requestId: string | undefined,
    store: RateLimitStore,
): Promise<CheckRateLimitResult> {
    // Circuit breaker: the store is failing systemically; fail open.
    if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
        if (Date.now() < circuitOpenUntil) {
            logger.warn({ requestId }, '[rate-limit] circuit open — skipping');
            return { allowed: true };
        }
        // Cooldown elapsed — let one request through to probe the store rather
        // than reopening the gate wholesale.
        consecutiveFailures = CIRCUIT_FAILURE_THRESHOLD - 1;
    }

    const outcome = await store.hit(key, {
        limit: options.limit,
        windowMs: options.windowMs,
    });

    if (outcome === 'unavailable') {
        consecutiveFailures++;
        if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
            circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
            logger.error(
                { requestId, cooldownMs: CIRCUIT_COOLDOWN_MS },
                `[rate-limit] circuit opened after ${CIRCUIT_FAILURE_THRESHOLD} systemic failures`,
            );
        }
        // Fail OPEN — a storage outage must not take the API down. Per-bucket
        // contention never reaches here: a binding reports that as `over`.
        return { allowed: true };
    }

    // The store answered, so it is healthy regardless of the verdict.
    consecutiveFailures = 0;

    if (outcome === 'over') {
        logger.warn({ requestId, key, limit: options.limit }, '[rate-limit] exceeded');
        return { allowed: false };
    }
    return { allowed: true };
}

/** Test-only: reset the module-scoped breaker between cases. */
export function resetRateLimitCircuitForTest(): void {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
}

/**
 * Build a rate-limit middleware with the given options. Call per-route:
 *
 *   app.get('/api/v1/handles', rateLimit(RATE_LIMITS.read), async (c) => { ... })
 */
export const rateLimit = (options: RateLimitOptions, customKey?: string): MiddlewareHandler => {
    return async (c, next) => {
        const xff = c.req.header('x-forwarded-for');
        const ip = extractClientIp(xff);
        // The June 2026 H5 investigation confirmed the TRUSTED_PROXY_HOPS offset
        // in client-ip.ts, so the per-request diagnostic that verified it is
        // gone — it logged the full XFF chain and the extracted client IP at
        // `info` on EVERY rate-limited request, which is a lot of addresses to
        // keep in Cloud Logging for a question already answered.
        //
        // What it was also serving as — the detector for the platform changing
        // its hop count — survives in this narrower form. If the topology moves,
        // the entry we index lands outside the chain and extraction collapses to
        // 'unknown', which also means every such caller shares one rate-limit
        // bucket. That is the symptom worth paging on, it fires only when
        // something is actually wrong, and it needs no client address to say so.
        if (ip === 'unknown' && xff) {
            logger.warn(
                { requestId: c.get('requestId'), xffEntries: xff.split(',').length },
                '[rate-limit] client IP unresolvable from a present XFF chain — TRUSTED_PROXY_HOPS may no longer match the platform; all such callers share one bucket',
            );
        }
        const key = `ratelimit_${customKey || ip}`;
        const result = await checkRateLimit(
            key,
            options,
            c.get('requestId'),
            // Resolved per request off the composition root, so the
            // Firestore → Neon cutover governs these buckets like every other
            // table rather than being quietly exempt from it.
            servicesFor(c.env as Record<string, unknown> | undefined).rateLimitStore,
        );
        if (!result.allowed) {
            // Thrown, not returned, so each inbound adapter serializes it in its
            // own dialect (REST envelope vs XRPC `{ error, message }`) — see the
            // note in middleware/auth.ts.
            //
            // `ServiceError` with an explicit code rather than `RateLimitError`:
            // that subclass carries `code: 'RATE_LIMIT'`, and this response has
            // always sent `'RATE_LIMITED'`. Swapping the string would silently
            // break any client branching on it.
            throw new ServiceError(
                options.message || 'Too many requests',
                429,
                undefined,
                'RATE_LIMITED',
            );
        }
        return next();
    };
};
