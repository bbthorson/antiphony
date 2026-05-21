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
 * secret. Hand-rolled (no `crypto.timingSafeEqual` to avoid Buffer
 * allocation hot in the path) — the typical token length is short so
 * the bounded-loop comparison is fast.
 */

/**
 * Constant-time string comparison. Always iterates the longer string's
 * length so the time taken doesn't leak which prefix matched. Returns
 * true iff the strings are byte-identical.
 */
function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        // Length mismatch is an immediate reject — but we still walk
        // through one full pass to keep the timing flat (defends
        // against length-leak via response latency).
        let diff = 1;
        const len = Math.max(a.length, b.length);
        for (let i = 0; i < len; i++) {
            diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
        }
        return diff === 0 && false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

function extractBearer(authHeader: string | undefined): string | null {
    if (!authHeader) return null;
    const prefix = 'Bearer ';
    if (!authHeader.startsWith(prefix)) return null;
    const token = authHeader.slice(prefix.length).trim();
    return token || null;
}

/**
 * System-auth middleware. Verifies that the bearer token matches
 * `SYSTEM_AUTH_TOKEN`. On mismatch: 401. On missing token: 401. On
 * unset env var: 503 (fail-closed).
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
