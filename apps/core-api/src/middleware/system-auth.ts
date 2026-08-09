import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { logger } from '../lib/logger.js';
import { errorEnvelope } from '../lib/error-envelope.js';

/**
 * System-auth middleware — verifies that the request comes from a trusted
 * sibling service or from infrastructure this deployment owns, rather than
 * from an application acting for a user.
 *
 * Mechanism: shared-secret bearer auth. The caller sends
 * `Authorization: Bearer <SYSTEM_AUTH_TOKEN>` where the token value
 * matches the `SYSTEM_AUTH_TOKEN` env var in core-api (sourced from
 * Secret Manager in production, .env locally). On mismatch / missing
 * header: 401.
 *
 * Who actually presents it today: the Cloud Tasks queue calling back into
 * `/api/v1/system/process-audio` with each enrichment job (the enqueuing
 * adapter bakes this token into every task's headers), and a tenant's BFF
 * calling the `/api/v1/system/*` endpoints — rate-limit checks, AT Protocol
 * session and sign-in helpers — that exist so it doesn't need
 * `firebase-admin` of its own.
 *
 * Why not `requireAuth()`, the service-token middleware every data route uses:
 *
 *   - A service token identifies an APPLICATION and carries a tenancy
 *     (`originAppId`), so everything behind it is scoped to that tenant.
 *     System routes are deliberately outside that model — a queue callback
 *     has no tenant asserting it, and some system lookups are cross-tenant
 *     by nature.
 *   - Keeping them on a separate credential makes the privilege boundary
 *     explicit: these endpoints expose things a trusted sibling needs and
 *     that an ordinary application MUST NOT be able to reach, so sharing
 *     the app credential would silently widen every tenant's authority.
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
 * Manager, mounted by the deploy workflow's `--set-secrets` in prod;
 * `.env` for local dev). If the
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
