import type { MiddlewareHandler } from 'hono';
import { logger } from '../lib/logger.js';
import { errorEnvelope } from '../lib/error-envelope.js';
import { constantTimeEqual } from '../lib/constant-time.js';

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
 *   - Originally: both deployments were Firebase App Hosting backends, and
 *     App Hosting's wrapper did not surface a clean service-account-to-
 *     service-account flow at the HTTP layer the way Cloud Run does.
 *   - THAT REASON EXPIRED at the 2026-08-09 Cloud Run migration. This side
 *     now runs on Cloud Run and can both mint and verify metadata-server ID
 *     tokens, so the constraint that chose a shared secret is gone. What
 *     remains is that the callers — Cloud Tasks and each tenant's BFF — would
 *     all have to move in lockstep, which is a bigger change than this
 *     middleware.
 *   - Shared secret still works and is not insecure; it is simply no longer
 *     the only option. Rotation: change the secret in Secret Manager +
 *     re-deploy. This middleware remains the swap point if ID tokens are
 *     ever taken up.
 *
 * Configuration: set `SYSTEM_AUTH_TOKEN` in core-api's env (Secret
 * Manager, mounted by the deploy workflow's `--set-secrets` in prod;
 * `.env` for local dev). If the
 * env var is unset, all system-auth requests get 503 — fail-closed,
 * never silently downgrade to "all requests allowed". Surrounding whitespace
 * on the stored value is ignored, so a secret piped in with a trailing
 * newline still authenticates.
 *
 * Constant-time comparison defends against timing side-channels on the
 * secret (same approach as service-auth).
 */

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
        // Trim ONCE and use the trimmed value for every subsequent check —
        // the length gate below and the comparison further down must agree.
        // A secret set by piping (`gcloud secrets versions access ... |
        // wrangler secret put ...`) commonly carries a trailing newline; if
        // only the gate trimmed, such a value would clear the gate and then
        // fail every comparison, surfacing as "token mismatch" 401s that look
        // like a wrong token. The stored value is write-only in Cloudflare, so
        // that misdiagnosis is not something an operator can check by reading
        // the secret back. `presented` needs no trim here — `extractBearer`
        // already trims what it returns.
        const expected = process.env.SYSTEM_AUTH_TOKEN?.trim();
        if (!expected) {
            // Fail-closed — refusing the request is better than silently
            // letting it through. The deployment is misconfigured.
            logger.error(
                { requestId: c.get('requestId') },
                '[system-auth] SYSTEM_AUTH_TOKEN env var is unset; refusing',
            );
            return c.json(errorEnvelope(c, 'System auth not configured'), 503);
        }

        if (expected.length < SYSTEM_AUTH_TOKEN_MIN_LENGTH) {
            // Token is set but too short to provide adequate security.
            // Fail-closed — refuse all requests until the secret is rotated.
            logger.error(
                {
                    requestId: c.get('requestId'),
                    minLength: SYSTEM_AUTH_TOKEN_MIN_LENGTH,
                    actualLength: expected.length,
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
