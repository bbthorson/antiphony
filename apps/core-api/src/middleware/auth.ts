import type { MiddlewareHandler } from 'hono';
import { matchServiceToken } from './service-auth.js';
import { errorEnvelope } from '../lib/error-envelope.js';

/**
 * Auth bridge middleware. Two variants:
 *
 *   - `optionalAuth()` — reads `Authorization: Bearer <token>` if present,
 *     resolves it as a service token, and attaches the acting actor to
 *     `c.var.viewerUid`. Absent or unrecognized tokens produce
 *     `viewerUid = null` (no error). Use on endpoints that have a public
 *     path and an owner-aware branch.
 *
 *   - `requireAuth()` — same resolution but returns 401 if the header is
 *     missing or the token is not a recognized service token. Use on
 *     endpoints that require an authenticated caller.
 *
 * ## Token resolution (specs/service-auth.md, specs/core-surface.md)
 *
 * The **service token is the only accepted credential**. A caller presenting
 * a token in `ANTIPHONY_APP_TOKENS` is an authenticated APPLICATION: tenancy
 * (`originAppId`) comes from the matched app, and the acting end user is
 * asserted via `X-Antiphony-Acting-Actor` (+ optional
 * `X-Antiphony-Acting-Actor-Did`) and trusted within the app's tenancy.
 *
 * Antiphony is headless — every caller is an application (a BFF), so it
 * verifies no end-user identity tokens. The inherited Firebase ID-token /
 * session-cookie fallback was removed (see core-surface.md, "Auth:
 * service-token only").
 *
 * ## Context shape
 *
 * After either middleware runs:
 *   - `c.get('viewerUid'): string | null` — app-asserted acting user's id, or null.
 *   - `c.get('originAppId'): string | null` — tenancy key from the service
 *     credential, or null (caller then falls back to the env default via
 *     `getOriginAppId(c)`).
 *   - `c.get('actingActorDid'): string | null` — app-asserted AT Protocol
 *     DID of the acting user.
 */

declare module 'hono' {
    interface ContextVariableMap {
        /** Acting user's id (app-asserted actor), or null when anonymous. */
        viewerUid: string | null;
        /** Tenancy key derived from a service credential, or null when anonymous. */
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
 * middlewares need it on the no-credential branch (optionalAuth always;
 * requireAuth on the subsequent 401 response path, where handlers shouldn't
 * see stale auth state if they read `c.var` defensively).
 */
function setAnonymous(
    c: Parameters<MiddlewareHandler>[0],
): void {
    c.set('viewerUid', null);
    c.set('originAppId', null);
    c.set('actingActorDid', null);
}

/**
 * Try the service-token path. Returns true when the bearer matched a
 * configured app token (context is then fully decorated); false otherwise.
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
    c.set('originAppId', appId);
    // A DID assertion without an actor is meaningless — ignore it.
    c.set('actingActorDid', actor ? did : null);
    return true;
}

/**
 * Optional auth — never errors; just decorates the context. A missing or
 * unrecognized token yields anonymous state (a stale/wrong credential must
 * not block a public endpoint).
 */
export const optionalAuth = (): MiddlewareHandler => {
    return async (c, next) => {
        const token = extractBearer(c.req.header('authorization'));
        if (token && tryServiceAuth(c, token)) {
            return next();
        }
        setAnonymous(c);
        return next();
    };
};

/**
 * Required auth — 401 on a missing header OR a token that is not a
 * recognized service token. Response shape follows the error-handler
 * middleware's format so clients can consume both transport-level and
 * handler-level auth failures the same way.
 */
export const requireAuth = (): MiddlewareHandler => {
    return async (c, next) => {
        const token = extractBearer(c.req.header('authorization'));
        if (!token) {
            setAnonymous(c);
            return c.json(errorEnvelope(c, 'Authentication required'), 401);
        }

        if (!tryServiceAuth(c, token)) {
            setAnonymous(c);
            return c.json(errorEnvelope(c, 'Invalid service token'), 401);
        }

        // requireAuth semantics need an acting user: an app calling a
        // viewer-required endpoint must say WHO is acting.
        if (!c.get('viewerUid')) {
            return c.json(
                errorEnvelope(c, 'X-Antiphony-Acting-Actor header required for this endpoint'),
                401,
            );
        }
        return next();
    };
};
