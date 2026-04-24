import type { MiddlewareHandler } from 'hono';
import { sessionVerifier } from '../lib/auth/session-verifier.js';
import { logger } from '../lib/logger.js';

/**
 * Auth bridge middleware. Two variants:
 *
 *   - `optionalAuth()` — reads `Authorization: Bearer <token>` if present,
 *     verifies via `sessionVerifier`, and attaches the viewer uid to
 *     `c.var.viewerUid`. Absent or invalid tokens produce `viewerUid = null`
 *     (no error). Use on endpoints that have a public path and an
 *     owner-aware branch.
 *
 *   - `requireAuth()` — same as above but returns 401 if the header is
 *     missing or the token is invalid. Use on endpoints that require
 *     an authenticated viewer.
 *
 * The token can be either a Firebase ID token (mobile, embed, browser)
 * or a Firebase session cookie value (apps/web RSC). See
 * `session-verifier.ts` for the dual-verification rationale.
 *
 * ## Context shape
 *
 * After either middleware runs:
 *   - `c.get('viewerUid'): string | null` — authenticated user's uid, or null.
 *   - `c.get('viewerSession'): VerifiedSession | null` — full decoded
 *     token, including custom claims (e.g. `currentOrg`). Use when a
 *     handler needs claims beyond the uid.
 */

declare module 'hono' {
    interface ContextVariableMap {
        /** Authenticated user's uid, or null when anonymous. Set by auth middleware. */
        viewerUid: string | null;
        /** Full verified session with custom claims, or null when anonymous. */
        viewerSession: import('../lib/auth/session-verifier.js').VerifiedSession | null;
    }
}

/**
 * Extract a bearer token from the `Authorization` header. Returns null
 * when the header is absent or malformed (doesn't start with `Bearer `).
 * Deliberately strict: case-sensitive `Bearer ` prefix matches the RFC
 * 6750 convention that most clients use.
 */
function extractBearer(authHeader: string | undefined): string | null {
    if (!authHeader) return null;
    const prefix = 'Bearer ';
    if (!authHeader.startsWith(prefix)) return null;
    const token = authHeader.slice(prefix.length).trim();
    return token || null;
}

/**
 * Set anonymous viewer state on the context. Extracted because both
 * middlewares need it on the no-token-present branch (optionalAuth
 * always; requireAuth only for the subsequent 401 response path, where
 * handlers shouldn't see stale auth state if they read `c.var` defensively).
 */
function setAnonymous(
    c: Parameters<MiddlewareHandler>[0],
): void {
    c.set('viewerUid', null);
    c.set('viewerSession', null);
}

/**
 * Optional auth — never errors; just decorates the context.
 */
export const optionalAuth = (): MiddlewareHandler => {
    return async (c, next) => {
        const token = extractBearer(c.req.header('authorization'));
        if (!token) {
            setAnonymous(c);
            return next();
        }

        try {
            const session = await sessionVerifier.verifyToken(token);
            c.set('viewerUid', session.uid);
            c.set('viewerSession', session);
        } catch (err) {
            // Invalid token on an optional-auth route means "treat as
            // anonymous" — not a 401. This matches apps/web's behavior:
            // a stale/expired cookie doesn't block a public endpoint.
            logger.debug(
                { err: (err as Error)?.message, requestId: c.get('requestId') },
                '[auth] optional-auth token verification failed; treating as anonymous',
            );
            setAnonymous(c);
        }

        return next();
    };
};

/**
 * Required auth — 401 on missing header OR invalid token. Response shape
 * follows the error-handler middleware's format (`{status, message,
 * requestId}`) so clients can consume both transport-level and handler-
 * level auth failures the same way.
 */
export const requireAuth = (): MiddlewareHandler => {
    return async (c, next) => {
        const token = extractBearer(c.req.header('authorization'));
        if (!token) {
            setAnonymous(c);
            return c.json(
                {
                    status: 'error',
                    message: 'Authentication required',
                    requestId: c.get('requestId'),
                },
                401,
            );
        }

        try {
            const session = await sessionVerifier.verifyToken(token);
            c.set('viewerUid', session.uid);
            c.set('viewerSession', session);
        } catch (err) {
            setAnonymous(c);
            logger.info(
                { err: (err as Error)?.message, requestId: c.get('requestId') },
                '[auth] required-auth token verification failed',
            );
            return c.json(
                {
                    status: 'error',
                    message: 'Invalid or expired session',
                    requestId: c.get('requestId'),
                },
                401,
            );
        }

        return next();
    };
};
