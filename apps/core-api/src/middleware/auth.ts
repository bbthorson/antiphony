import type { MiddlewareHandler } from 'hono';
import { ServiceError } from 'shared/errors';
import { matchServiceToken } from './service-auth.js';
import { ensureTenantPin, type PinCacheKV } from '../lib/app-did.js';
import { APP_CONFIG } from '../lib/app-config.js';
import { logger } from '../lib/logger.js';

/**
 * Auth bridge middleware. Two variants — both require a valid service token
 * (there is no tokenless path; every data route is gated):
 *
 *   - `requireServiceToken()` — 401 on a missing/unrecognized token. Attaches
 *     the acting actor to `c.var.viewerUid` from `X-Antiphony-Acting-Actor`,
 *     which MAY be absent (`viewerUid = null` → anonymous, viewer-less read).
 *     Use on tenancy-scoped reads with a public projection.
 *
 *   - `requireAuth()` — same, but additionally 401s when no acting actor is
 *     asserted. Use on endpoints that need to know WHO is acting (writes,
 *     viewer-scoped lists).
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
 *     credential; always set on a gated route (null only pre-auth).
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
 * Shared service-token gate for both required-auth middlewares. Extracts the
 * bearer, rejects a missing or unrecognized token, and decorates the context on
 * success.
 *
 * ## Why this throws instead of returning a response
 *
 * This middleware is mounted under two inbound adapters that disagree about
 * what an error looks like on the wire: REST answers with the standard envelope
 * (`{ success: false, error: { message }, requestId }`) and XRPC answers with
 * the AT Protocol shape (`{ error, message }`). A middleware that builds the
 * response itself can only serve one of them, so it raises a typed
 * `ServiceError` and each adapter's `onError` serializes it in its own dialect.
 * Hono routes a throw from mounted middleware to the mounted sub-app's
 * `onError`, which is what makes this work. See specs/xrpc-and-atproto-lex-
 * strategy.md §5.3.
 *
 * `ServiceError` directly, rather than the `UnauthorizedError` subclass: that
 * subclass carries `code: 'UNAUTHORIZED'`, and these responses have never had a
 * `code`. Adding one is a client-visible change to the REST contract and is not
 * this refactor's to make.
 */
function serviceTokenGate(c: Parameters<MiddlewareHandler>[0]): void {
    const token = extractBearer(c.req.header('authorization'));
    if (!token) {
        setAnonymous(c);
        throw new ServiceError('Authentication required', 401);
    }
    if (!tryServiceAuth(c, token)) {
        setAnonymous(c);
        throw new ServiceError('Invalid service token', 401);
    }
}

/**
 * Prove custody of this tenant's app DID before any handler runs.
 *
 * ## Why the pin check lives in the auth middleware
 *
 * `src/index.ts` proves every pin at boot and `process.exit(1)`s on failure, so
 * `getAppDid()` — a synchronous accessor serving only from that snapshot — can
 * never answer with an authority we have not proven. Workers have no boot
 * phase, so that ordering has to be established somewhere else, and this is the
 * right somewhere: these two middlewares already resolve `originAppId`, they
 * ARE the tenancy boundary, and a pin is a tenancy property. A fourth
 * middleware would have to be ordered against them and would sometimes be
 * ordered wrong.
 *
 * Doing the async work HERE is what keeps `getAppDid()` synchronous. Making the
 * accessor async would ripple through `AudioPostService` and
 * `AudioProcessingService` — into `packages/core`, which this migration has
 * otherwise left untouched — for no benefit, since by the time a handler runs
 * the snapshot is populated either way.
 *
 * ## Cost
 *
 * Nothing on a warm isolate: the check is a map lookup that returns
 * immediately inside the freshness window. A cold isolate pays one KV read, and
 * only a cold isolate whose KV entry has also aged out pays the `did:web`
 * fetch, bounded by its existing 5s timeout. With one tenant in beta that is
 * approximately nothing.
 *
 * ## 503, not 401
 *
 * The caller's credential was fine — we established that a line earlier. What
 * failed is our ability to serve this tenant safely, which is a readiness
 * statement about us and is retryable. A 401 would send an integrator looking
 * at their token.
 */
async function tenantPinGate(c: Parameters<MiddlewareHandler>[0]): Promise<void> {
    const originAppId = c.get('originAppId');
    if (!originAppId) return;

    const env = c.env as Record<string, unknown> | undefined;
    try {
        await ensureTenantPin(originAppId, {
            expectedPdsHost: APP_CONFIG.PDS_HOST,
            kv: env?.PIN_CACHE as PinCacheKV | undefined,
        });
    } catch (err) {
        logger.error(
            { err, originAppId, requestId: c.get('requestId') },
            '[auth] app-DID custody unproven for tenant; refusing the request',
        );
        throw new ServiceError('Tenant temporarily unavailable', 503);
    }
}

/**
 * Require a valid service token, but NOT an acting actor. Use on tenancy-scoped
 * reads that have a public (viewer-less) projection: the app must authenticate
 * so the credential establishes *which tenant* is being read, but it may omit
 * `X-Antiphony-Acting-Actor` for an anonymous read (`viewerUid = null` → public
 * view). 401 on a missing header or a token that isn't a recognized service
 * token.
 *
 * This is the tokenless-reads gate (specs/core-surface.md, "tokenless public
 * reads"): every data route now carries a token, so tenancy is never inferred
 * from a deploy-level default.
 */
export const requireServiceToken = (): MiddlewareHandler => {
    return async (c, next) => {
        serviceTokenGate(c);
        await tenantPinGate(c);
        return next();
    };
};

/**
 * Required auth — `requireServiceToken` plus an acting-actor assertion. 401 on
 * a missing/unrecognized token OR a valid token with no `X-Antiphony-Acting-
 * Actor`. Use on endpoints that need to know WHO is acting (writes,
 * viewer-scoped lists).
 */
export const requireAuth = (): MiddlewareHandler => {
    return async (c, next) => {
        serviceTokenGate(c);

        // requireAuth semantics need an acting user: an app calling a
        // viewer-required endpoint must say WHO is acting.
        if (!c.get('viewerUid')) {
            throw new ServiceError(
                'X-Antiphony-Acting-Actor header required for this endpoint',
                401,
            );
        }
        await tenantPinGate(c);
        return next();
    };
};
