import { Hono } from 'hono';
import { z } from 'zod';
import { requireSystemAuth } from '../../../middleware/system-auth.js';
import { checkRateLimit } from '../../../middleware/rate-limit.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

/**
 * POST /api/v1/system/rate-limit/check
 *
 * Sibling-service rate-limit check. Apps/web's rate-limit shim calls this
 * endpoint instead of touching Firestore directly, so apps/web no longer
 * needs `firebase-admin` in its dependency tree. This is stage 1 of the
 * PR-F3b firebase-admin purge.
 *
 * **Requires system-auth, NOT user-auth.** The caller is another service
 * in the trust circle (apps/web, future tier-2 deployables) that has
 * already extracted the IP (or a custom key) and chosen rate-limit
 * options for the route under check. End users must never hit this
 * endpoint — it would let them probe the rate-limit state of arbitrary
 * keys.
 *
 * Behavior matches the in-process `rateLimit(...)` Hono middleware
 * exactly: both call `checkRateLimit(key, options, requestId?)`. Same
 * Firestore collection, same circuit breaker, same per-bucket-contention
 * fail-closed semantics, same fail-open on systemic Firestore errors.
 *
 * ## Response shape
 *
 * On allowed:   `200 { success: true, data: { allowed: true } }`
 * On rate-limited or per-bucket contention:
 *   `429 { success: false, error: { message, code: 'RATE_LIMITED' }, requestId }`
 *
 * The 429 path uses the standard Phase 4 error envelope so apps/web can
 * pass the response back to its caller without reshaping. The `code:
 * 'RATE_LIMITED'` discriminator lets future API consumers branch on
 * envelope code rather than HTTP status alone.
 *
 * ## requestId propagation
 *
 * The caller's `X-Request-ID` header arrives via the request-id
 * middleware (which prefers an inbound header over a generated id), so
 * log lines from this endpoint correlate with the apps/web requestId
 * that triggered the check. No extra plumbing needed.
 */

const CheckRequestSchema = z.object({
    /**
     * Firestore doc id under `rate_limits/`. Typically `ratelimit_<ip>` or
     * a custom key set by the caller. The caller is responsible for IP
     * extraction + private-IP rejection; the endpoint is key-agnostic.
     *
     * Constraints enforce Firestore doc-id legality: no slashes (would
     * traverse into a sub-collection), no `.` / `..` (reserved), and a
     * length cap. Current callers pass `ratelimit_<ip>` or
     * `ratelimit_<uid>` which all comply trivially; the schema guards
     * against a future caller passing a path-shaped or reserved value.
     */
    key: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[^/]+$/, 'Key must not contain slashes')
        .refine((s) => s !== '.' && s !== '..', { message: 'Key must not be `.` or `..`' }),
    /**
     * Requests permitted per window. Matches the `limit` field of the
     * caller's `RateLimitOptions`.
     */
    limit: z.number().int().positive().max(100_000),
    /**
     * Window duration in milliseconds. Bounded conservatively — 1ms
     * minimum (to avoid divide-by-zero / nonsense windows) and 24h max
     * (no practical use case beyond that, and the TTL-cleanup buffer adds
     * an extra hour so the doc lifetime stays reasonable).
     */
    windowMs: z.number().int().min(1).max(24 * 60 * 60 * 1000),
    /**
     * Optional human-readable message echoed in the 429 response body.
     * Kept under a small char cap so misconfigured callers can't blow
     * past the response-body size budget.
     */
    message: z.string().max(256).optional(),
});

const app = new Hono();

app.post('/check', requireSystemAuth(), async (c) => {
    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = CheckRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid request body', { issues: validation.error.issues }),
            400,
        );
    }

    const { key, limit, windowMs, message } = validation.data;

    const result = await checkRateLimit(key, { limit, windowMs, message }, c.get('requestId'));

    if (!result.allowed) {
        return c.json(
            errorEnvelope(c, message ?? 'Too many requests', { code: 'RATE_LIMITED' }),
            429,
        );
    }

    return c.json({ success: true, data: { allowed: true } });
});

export { app as rateLimitCheckRoute };
