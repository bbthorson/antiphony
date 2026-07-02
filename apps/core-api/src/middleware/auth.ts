import type { MiddlewareHandler } from 'hono';
import { sessionVerifier } from '../lib/auth/session-verifier.js';
import { matchServiceToken } from './service-auth.js';
import { logger } from '../lib/logger.js';
import { errorEnvelope } from '../lib/error-envelope.js';

/**
 * Auth bridge middleware. Two variants:
 *
 *   - `optionalAuth()` — reads `Authorization: Bearer <token>` if present,
 *     resolves it (see order below), and attaches the viewer uid to
 *     `c.var.viewerUid`. Absent or invalid tokens produce `viewerUid = null`
 *     (no error). Use on endpoints that have a public path and an
 *     owner-aware branch.
 *
 *   - `requireAuth()` — same as above but returns 401 if the header is
 *     missing or the token is invalid. Use on endpoints that require
 *     an authenticated viewer.
 *
 * ## Token resolution order (specs/service-auth.md)
 *
 *   1. **Service token** — the caller is an authenticated APPLICATION
 *      (`ANTIPHONY_APP_TOKENS`). Tenancy (`originAppId`) comes from the
 *      matched app; the acting end user is asserted via
 *      `X-Antiphony-Acting-Actor` (+ optional `X-Antiphony-Acting-Actor-Did`)
 *      and trusted within the app's tenancy.
 *   2. **End-user token** — a Firebase ID token (mobile, embed, browser) or
 *      session cookie value; verified via `sessionVerifier`. The per-deploy
 *      compatibility/demo path — tenancy falls back to the env default.
 *
 * ## Context shape
 *
 * After either middleware runs:
 *   - `c.get('viewerUid'): string | null` — acting user's id, or null.
 *   - `c.get('viewerSession'): VerifiedSession | null` — full decoded
 *     token (end-user mode only; null on the service path).
 *   - `c.get('originAppId'): string | null` — tenancy key from the service
 *     credential, or null (caller then falls back to the env default via
 *     `getOriginAppId(c)`).
 *   - `c.get('actingActorDid'): string | null` — app-asserted AT Protocol
 *     DID of the acting user (service path only).
 */

declare module 'hono' {
    interface ContextVariableMap {
        /** Acting user's id (verified end user, or app-asserted actor), or null when anonymous. */
        viewerUid: string | null;
        /** Full verified session with custom claims; null when anonymous or on the service path. */
        viewerSession: import('../lib/auth/session-verifier.js').VerifiedSession | null;
        /** Tenancy key derived from a service credential, or null in end-user mode. */
        originAppId: string | null;
        /** App-asserted AT Protocol DID of the acting user, or null. */
        actingActorDid: string | null;
    }
}

/** Header carrying the app-asserted acting user id (service path). */
export const ACTING_ACTOR_HEADER = 'x-antiphony-acting-actor';
/** Header carrying the app-asserted acting user DID (service path, optional). */
export const ACTING_ACTOR_DID_HEADER = 'x-antiphony-acting-actor-did';

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
    c.set('originAppId', null);
    c.set('actingActorDid', null);
}

/**
 * Try the service-token path. Returns true when the bearer matched a
 * configured app token (context is then fully decorated); false to fall
 * through to end-user verification.
 */
function tryServiceAuth(
    c: Parameters<MiddlewareHandler>[0],
    token: string,
): boolean {
    const appId = matchServiceToken(token);
    if (!appId) return false;

    const actor = c.req.header(ACTING_ACTOR_HEADER)?.trim() || null;
    const did = c.req.header(ACTING_ACTOR_DID_HEADER)?.trim() || null;
    c.set('viewerUid', actor);
    c.set('viewerSession', null);
    c.set('originAppId', appId);
    // A DID assertion without an actor is meaningless — ignore it.
    c.set('actingActorDid', actor ? did : null);
    return true;
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

        // Service path first: app tokens are long random strings that can
        // never verify as Firebase JWTs, so this adds no risk and no cost.
        if (tryServiceAuth(c, token)) {
            return next();
        }

        try {
            const session = await sessionVerifier.verifyToken(token);
            c.set('viewerUid', session.uid);
            c.set('viewerSession', session);
            c.set('originAppId', null);
            c.set('actingActorDid', null);
        } catch (err) {
            // Invalid token on an optional-auth route means "treat as
            // anonymous" — not a 401. This matches apps/web's behavior:
            // a stale/expired cookie doesn't block a public endpoint.
            logger.debug(
                { err, requestId: c.get('requestId') },
                '[auth] optional-auth token verification failed; treating as anonymous',
            );
            setAnonymous(c);
        }

        return next();
    };
};

/**
 * Required auth — 401 on missing header OR invalid token. Response shape
 * follows the error-handler middleware's format so clients can consume
 * both transport-level and handler-level auth failures the same way.
 */
export const requireAuth = (): MiddlewareHandler => {
    return async (c, next) => {
        const token = extractBearer(c.req.header('authorization'));
        if (!token) {
            setAnonymous(c);
            return c.json(errorEnvelope(c, 'Authentication required'), 401);
        }

        if (tryServiceAuth(c, token)) {
            // requireAuth semantics need an acting user: an app calling a
            // viewer-required endpoint must say WHO is acting.
            if (!c.get('viewerUid')) {
                return c.json(
                    errorEnvelope(c, 'X-Antiphony-Acting-Actor header required for this endpoint'),
                    401,
                );
            }
            return next();
        }

        try {
            const session = await sessionVerifier.verifyToken(token);
            c.set('viewerUid', session.uid);
            c.set('viewerSession', session);
            c.set('originAppId', null);
            c.set('actingActorDid', null);
        } catch (err) {
            setAnonymous(c);
            logger.info(
                { err, requestId: c.get('requestId') },
                '[auth] required-auth token verification failed',
            );
            return c.json(errorEnvelope(c, 'Invalid or expired session'), 401);
        }

        return next();
    };
};
