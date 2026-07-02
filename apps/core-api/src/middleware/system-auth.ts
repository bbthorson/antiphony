import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { logger } from '../lib/logger.js';
import { errorEnvelope } from '../lib/error-envelope.js';

/**
 * System-auth middleware — verifies that the request comes from a trusted
 * sibling service (apps/telephony / future tier-2 deployables) rather
 * than an end user.
 *
 * Mechanism: shared-secret bearer auth. The caller sends
 * `Authorization: Bearer <SYSTEM_AUTH_TOKEN>` where the token value
 * matches the `SYSTEM_AUTH_TOKEN` env var in core-api (sourced from
 * Secret Manager in production, .env locally). On mismatch / missing
 * header: 401.
 *
 * Why not the same `requireAuth()` middleware that handles user tokens:
 *
 *   - User tokens are Firebase ID tokens or session cookies, scoped to
 *     a specific uid. System lookups (e.g. "find the user behind this
 *     phone number") don't have a calling user — they're driven by an
 *     external trigger (a Twilio SIP webhook hits apps/telephony,
 *     which then asks core-api "whose forwarding is this phone").
 *   - Using a service-bound shared secret keeps the privilege model
 *     explicit: system-auth endpoints expose data the calling service
 *     needs across the apps/telephony tier — but they MUST NOT be
 *     callable by end users.
 *
 * Why shared secret rather than e.g. Cloud Run identity tokens:
 *
 *   - Both deployments are Firebase App Hosting backends. App Hosting
 *     doesn't currently expose a clean service-account-to-service-
 *     account auth flow at the HTTP layer (Cloud Run does via
 *     metadata-server-issued ID tokens, but App Hosting's wrapper
 *     doesn't surface that as cleanly).
 *   - Shared secret is the simplest mechanism that works today.
 *     Rotation: change the secret in Secret Manager + re-deploy.
 *     Future hardening: GCP-issued ID tokens (this middleware is the
 *     swap point).
 *
 * Configuration: set `SYSTEM_AUTH_TOKEN` in core-api's env (Secret
 * Manager via apphosting.yaml in prod, `.env` for local dev). If the
 * env var is unset, all system-auth requests get 503 — fail-closed,
 * never silently downgrade to "all requests allowed".
 *
 * Constant-time comparison defends against timing side-channels on the
 * secret (same approach as service-auth).
 */

/**
 * Constant-time string comparison. Hash both sides to fixed-length digests,
 * then compare with the native `crypto.timingSafeEqual` — no timing or
 * length leaks, no hand-rolled loop the JIT could optimize out of constant
 * time.
 */
function constantTimeEqual(a: string, b: string): boolean {
    const aHash = createHash('sha256').update(a).digest();
    const bHash = createHash('sha256').update(b).digest();
    return timingSafeEqual(aHash, bHash);
}

function extractBearer(authHeader: string | undefined): string | null {
    if (!authHeader) return null;
    const prefix = 'Bearer ';
    if (!authHeader.startsWith(prefix)) return null;
    const token = authHeader.slice(prefix.length).trim();
    return token || null;
}

/**
 * Minimum acceptable length for SYSTEM_AUTH_TOKEN.
 *
 * A 32-character secret provides ~192 bits of entropy for a random
 * hex/alphanumeric value and matches NIST SP 800-132 guidance for
 * shared secrets used in bearer-token authentication. Shorter tokens
 * are rejected at startup rather than silently accepted.
 */
const SYSTEM_AUTH_TOKEN_MIN_LENGTH = 32;

/**
 * System-auth middleware. Verifies that the bearer token matches
 * `SYSTEM_AUTH_TOKEN`. On mismatch: 401. On missing token: 401. On
 * unset env var: 503 (fail-closed). On token shorter than
 * SYSTEM_AUTH_TOKEN_MIN_LENGTH: 503 (fail-closed).
 */
export const requireSystemAuth = (): MiddlewareHandler => {
    return async (c, next) => {
        const expected = process.env.SYSTEM_AUTH_TOKEN;
        if (!expected || expected.trim().length === 0) {
            // Fail-closed — refusing the request is better than silently
            // letting it through. The deployment is misconfigured.
            logger.error(
                { requestId: c.get('requestId') },
                '[system-auth] SYSTEM_AUTH_TOKEN env var is unset; refusing',
            );
            return c.json(errorEnvelope(c, 'System auth not configured'), 503);
        }

        if (expected.trim().length < SYSTEM_AUTH_TOKEN_MIN_LENGTH) {
            // Token is set but too short to provide adequate security.
            // Fail-closed — refuse all requests until the secret is rotated.
            logger.error(
                {
                    requestId: c.get('requestId'),
                    minLength: SYSTEM_AUTH_TOKEN_MIN_LENGTH,
                    actualLength: expected.trim().length,
                },
                '[system-auth] SYSTEM_AUTH_TOKEN is too short; refusing (rotate to ≥32 chars)',
            );
            return c.json(errorEnvelope(c, 'System auth misconfigured'), 503);
        }

        const presented = extractBearer(c.req.header('authorization'));
        if (!presented) {
            return c.json(errorEnvelope(c, 'System authentication required'), 401);
        }

        if (!constantTimeEqual(presented, expected)) {
            logger.warn(
                {
                    requestId: c.get('requestId'),
                    method: c.req.method,
                    url: c.req.path,
                },
                '[system-auth] token mismatch',
            );
            return c.json(errorEnvelope(c, 'Invalid system credentials'), 401);
        }

        return next();
    };
};
