import type { MiddlewareHandler } from 'hono';
import { extractClientIp } from '../lib/client-ip.js';
import { serviceCallerFrom } from './service-auth.js';
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
 * **The asymmetry is the load-bearing part** (rate-limit-policy.test.ts is
 * built around it):
 *
 *   - `unavailable` — the store is systemically unwell. Fail **OPEN** after the
 *     breaker trips: a storage outage must not take the whole API down.
 *   - `over` — refuse. A binding must report per-bucket contention as `over`
 *     rather than `unavailable` (the Firestore one did, and the port requires
 *     it of any successor), so a caller hammering one bucket cannot trip the
 *     breaker and fail-open the limiter for everyone.
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
 * and nothing external shares them any more, which is what made moving them off
 * Firestore a purely internal decision. They are on Postgres now, and on the
 * Durable Object wherever that binding is attached.
 */

export interface RateLimitOptions {
    limit: number;
    windowMs: number;
    message?: string;
    /**
     * Bucket name, which is a segment of the store key. Every preset sets one;
     * see `bucketFor`.
     */
    bucket?: string;
}

export const RATE_LIMITS = {
    /** Create/update operations (10 per 15 min). */
    write: { bucket: 'write', limit: 10, windowMs: 15 * 60 * 1000 } satisfies RateLimitOptions,
    /** Read/list operations (60 per min). */
    read: { bucket: 'read', limit: 60, windowMs: 60 * 1000 } satisfies RateLimitOptions,
    /**
     * Flood backstop for a route keyed by something OTHER than the client IP
     * (20 per second). Not a per-caller policy — deliberately far above what
     * any legitimate single address does, because the callers that legitimately
     * concentrate on one address are exactly the ones a per-IP policy hurts: a
     * sibling service, or Twilio's fetch pool during a busy period.
     *
     * It exists because a key derived from the REQUEST has unbounded
     * cardinality: an attacker minting distinct well-formed object paths gets a
     * fresh bucket per request, so the object-keyed limit alone bounds nothing
     * in aggregate. This is the bound that survives that.
     */
    readAggregate: { bucket: 'readAggregate', limit: 1200, windowMs: 60 * 1000 } satisfies RateLimitOptions,
    /**
     * The same backstop for a WRITE route keyed by something other than the
     * client IP (600 per min). Pairs with `write` on the post routes, whose real
     * policy is per acting actor.
     *
     * An actor-keyed bucket has the unbounded cardinality `readAggregate`
     * describes: the actor id is app-asserted, so a caller holding a service
     * token can mint a fresh bucket per request. This is the bound that survives
     * that. Deliberately far above real demand — ten writes a second across the
     * entire platform is orders of magnitude past anything observed — because an
     * aggregate that binds in normal operation is throttling a peer rather than
     * an abuser, which is the mistake the per-IP limit was already making.
     */
    writeAggregate: { bucket: 'writeAggregate', limit: 600, windowMs: 60 * 1000 } satisfies RateLimitOptions,
    /** Auth-sensitive operations (5 per min). */
    auth: { bucket: 'auth', limit: 5, windowMs: 60 * 1000 } satisfies RateLimitOptions,
    /** Uploads, deletes, maintenance tasks (20 per hour). */
    hourly: { bucket: 'hourly', limit: 20, windowMs: 60 * 60 * 1000 } satisfies RateLimitOptions,
    /** High-impact operations: org creation, AI generation (5 per hour). */
    sensitive: { bucket: 'sensitive', limit: 5, windowMs: 60 * 60 * 1000 } satisfies RateLimitOptions,
    /** Frequent writes: session management, autosave (20 per min). */
    burst: { bucket: 'burst', limit: 20, windowMs: 60 * 1000 } satisfies RateLimitOptions,
    /** Moderate operations: RSS imports (10 per min). */
    standard: { bucket: 'standard', limit: 10, windowMs: 60 * 1000 } satisfies RateLimitOptions,
} as const;

/**
 * Bucket segment of the store key.
 *
 * Without this, every preset shared one `ratelimit_<caller>` record: the 60/min
 * `read` checks a caller makes while browsing incremented the same counter that
 * `write` (10 per 15 min) then tested, so ordinary reads exhausted the write
 * allowance and creates 429'd. Presets must count independently.
 *
 * The `limit`x`windowMs` fallback separates inline options (no preset) that
 * differ in configuration — but two inline call sites sharing a limit and window
 * still share a bucket, since nothing distinguishes them. Only an explicit
 * `bucket` guarantees separation, which is why every preset sets one.
 *
 * Ported from the Vox Pop BFF's `middleware/rate-limit.ts`, which grew this for
 * the same reason and whose comment describes the same symptom. The two are
 * independent limiters over independent stores, so they need not stay in step —
 * but the bug is worth recognising in either.
 */
function bucketFor(options: RateLimitOptions): string {
    return options.bucket ?? `${options.limit}x${options.windowMs}`;
}

// Circuit breaker state — module-scoped intentionally so it persists across
// requests within the same isolate.
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 30_000;

/**
 * Result of a single rate-limit check. Discriminator is `allowed`:
 *
 *   - `allowed: true` — caller may proceed (under limit, or fail-open because
 *     the store is reporting systemic failures and the circuit is open).
 *   - `allowed: false` — caller is blocked. Two sub-cases, and the store does
 *     not distinguish them because the response is the same:
 *     - The bucket's count met or exceeded `limit` (normal rate-limit hit).
 *     - Per-bucket contention, which a binding reports as `over` rather than
 *       `unavailable`: many concurrent writers on one bucket is what the rate
 *       limit exists to catch, so it fails closed and does not feed the
 *       breaker.
 *
 * Discrimination is intentionally opaque to callers: they should respond
 * with 429 for any `allowed: false`. Surfacing the sub-reason would invite
 * UI branching on an internal implementation detail.
 */
export interface CheckRateLimitResult {
    allowed: boolean;
}

/**
 * Run a rate-limit check for one bucket against the composed store.
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
 *                to the Firestore store, and the middleware below never passed
 *                anything — so the Postgres binding from #86 could not be
 *                reached in production by any configuration, and the import put
 *                `firebase-admin` on the module graph of every rate-limited
 *                route. Both problems are gone with that store, but the
 *                required parameter stays: a default here is what made a
 *                binding unreachable by configuration, and that trap does not
 *                depend on which store fills it.
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
 * Per-route knobs that are not the limit itself.
 */
export interface RateLimitBehaviour {
    /** Fixed bucket id, replacing the client IP. */
    customKey?: string;
    /**
     * Derive the bucket id from the request instead of the client IP.
     *
     * Returning null falls back to the IP, which is the required behaviour
     * rather than a convenience: the derivation runs BEFORE the handler
     * validates anything, so it must be able to say "this request is not
     * something I can key" — a malformed or hostile input then shares the
     * caller's IP bucket instead of minting a bucket of its own.
     *
     * **A request-derived key has unbounded cardinality**, so a route using one
     * needs a second, IP-keyed limit above it (`RATE_LIMITS.readAggregate`) or
     * it has no aggregate bound at all. Pair them; do not replace.
     */
    keyBy?: (c: Parameters<MiddlewareHandler>[0]) => string | null;
    /**
     * Skip the limit entirely for a caller presenting a valid
     * `ANTIPHONY_APP_TOKENS` bearer.
     *
     * **Opt-in per route, deliberately.** Most rate-limited routes already sit
     * behind `requireServiceToken()`, so every caller that reaches them is
     * authenticated — a blanket exemption would silently delete the write limit
     * (10 per 15 min) rather than adjust it. This is for the routes that are
     * ANONYMOUS by design and are also called service-to-service, where the
     * IP key is actively wrong: every request from the sibling service carries
     * that service's address, so one bucket absorbs all of its traffic and the
     * limit throttles a peer instead of an abuser.
     */
    exemptServiceCallers?: boolean;
}

/**
 * Build a rate-limit middleware with the given options. Call per-route:
 *
 *   app.get('/api/v1/handles', rateLimit(RATE_LIMITS.read), async (c) => { ... })
 */
export const rateLimit = (
    options: RateLimitOptions,
    behaviour: RateLimitBehaviour = {},
): MiddlewareHandler => {
    const { customKey, exemptServiceCallers, keyBy } = behaviour;
    return async (c, next) => {
        // Checked before the IP is even extracted: an authenticated peer's
        // address is not a meaningful bucket, so computing one to discard it
        // would only invite someone to "fix" the exemption by keying on it.
        //
        // An invalid or absent token falls through to the normal IP limit
        // rather than being refused here — this middleware is not an
        // authenticator, and several routes carrying it are anonymous by
        // design. The trade this makes is explicit: a leaked app token now buys
        // rate-limit exemption as well as tenancy, which is one more reason the
        // 32-character minimum in service-auth.ts is enforced rather than
        // advisory.
        if (exemptServiceCallers && serviceCallerFrom(c.req.header('authorization'))) {
            return next();
        }
        const ip = extractClientIp(c.req.raw);
        // The detector for "the edge in front of this service changed and the
        // limiter silently went global".
        //
        // It used to be guarded on `ip === 'unknown' && xff` — an XFF chain that
        // is present but unresolvable, which is what a wrong TRUSTED_PROXY_HOPS
        // looks like. That guard is why it stayed silent through the failure it
        // was written for: moving to a Cloudflare Worker removed the XFF header
        // altogether, so there was no chain to be unresolvable, and every
        // request on the service shared one bucket for a day without a single
        // log line. The condition that matters is the SYMPTOM (no address, so
        // one bucket), never the mechanism that caused it.
        //
        // Unconditional, and at `warn`. In steady state this is silent: a
        // correctly-configured deployment resolves an address for essentially
        // every request. If it starts firing on every request, the limiter is
        // no longer per-caller — that is the page.
        if (ip === 'unknown') {
            logger.warn(
                {
                    requestId: c.get('requestId'),
                    source: process.env.CLIENT_IP_SOURCE ?? 'xff',
                    hasXff: Boolean(c.req.header('x-forwarded-for')),
                    hasCfConnectingIp: Boolean(c.req.header('cf-connecting-ip')),
                },
                '[rate-limit] client IP unresolvable — this caller shares ONE bucket with every other unresolvable caller',
            );
        }
        // Precedence: a request-derived key, then a fixed one, then the IP.
        // `keyBy` returning null is the normal path for anything it cannot make
        // sense of, and lands those requests in the IP bucket.
        //
        // The bucket name is part of the key. Without it every preset on a given
        // caller shared ONE counter, so a route's `read` traffic (60/min) spent
        // the same budget its `write` traffic (10 per 15 min) was measured
        // against — loading a page could exhaust the ability to post. That was
        // invisible while the IP segment was also collapsing to 'unknown',
        // because at that point there was only one counter in the system
        // anyway.
        const key = `ratelimit_${bucketFor(options)}_${keyBy?.(c) || customKey || ip}`;
        const result = await checkRateLimit(
            key,
            options,
            c.get('requestId'),
            // Resolved per request off the composition root, so these
            // buckets are governed by the same binding selection as every other
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
