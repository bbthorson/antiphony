import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { OPENAPI_INFO, OPENAPI_TAGS } from './lib/openapi-info.js';
import { requestId } from './middleware/request-id.js';
import { errorHandler } from './middleware/error-handler.js';
import { resolveRoute } from './adapters/inbound/rest/resolve.js';
import { promptsRoute } from './adapters/inbound/rest/prompts.js';
import { promptsRepliesRoute } from './adapters/inbound/rest/prompts-replies.js';
import { usersPromptsRoute } from './adapters/inbound/rest/users-prompts.js';
import { repliesFeedRoute } from './adapters/inbound/rest/replies-feed.js';
import { repliesSearchRoute } from './adapters/inbound/rest/replies-search.js';
import { repliesRoute } from './adapters/inbound/rest/replies.js';
import { systemRepliesRoute } from './adapters/inbound/rest/system-replies.js';
import { usersRoute } from './adapters/inbound/rest/users.js';
import { usersMeRoute } from './adapters/inbound/rest/users-me.js';
import { usersActionsRoute } from './adapters/inbound/rest/users-actions.js';
import { usersProfileRoute } from './adapters/inbound/rest/users-profile.js';
import { audioRoute } from './adapters/inbound/rest/audio.js';
import { promptsPublicRoute } from './adapters/inbound/rest/prompts-public.js';
import { rssParseRoute } from './adapters/inbound/rest/rss-parse.js';
import { audioUploadRoute } from './adapters/inbound/rest/audio-upload.js';
import { audioUploadPendingRoute } from './adapters/inbound/rest/audio-upload-pending.js';
import { organizationsRoute } from './adapters/inbound/rest/organizations.js';
import { peopleRoute } from './adapters/inbound/rest/people.js';
import { notificationsRoute } from './adapters/inbound/rest/notifications.js';
import { callForwardingRoute } from './adapters/inbound/rest/call-forwarding.js';
import { callForwardingLookupRoute } from './adapters/inbound/rest/call-forwarding-lookup.js';
import { connectorsRoute } from './adapters/inbound/rest/connectors.js';
import { connectorsSystemRoute } from './adapters/inbound/rest/connectors-system.js';
import { screeningRoute } from './adapters/inbound/rest/screening.js';
import { rateLimitCheckRoute } from './adapters/inbound/rest/rate-limit-check.js';
import { atprotoRoute } from './adapters/inbound/rest/atproto.js';
import { systemAtprotoStateRoute } from './adapters/inbound/rest/system-atproto-state.js';
import { systemAtprotoSessionRoute } from './adapters/inbound/rest/system-atproto-session.js';
import { systemAuthMintRoute } from './adapters/inbound/rest/system-auth-mint.js';
import { systemBlueskyIdentityRoute } from './adapters/inbound/rest/system-bluesky-identity.js';
import { systemAtprotoSigninRoute } from './adapters/inbound/rest/system-atproto-signin.js';

/**
 * Parse the `ALLOWED_ORIGINS` env var into the CORS allowlist.
 *
 * Format: comma-separated list of full origins (with scheme), e.g.
 *   `https://example.com,https://app.example.com,http://localhost:9002`
 *
 * Whitespace around entries is trimmed; empty entries are dropped. If the
 * env var is unset or all entries are empty, falls back to a single
 * `http://localhost:9002` entry — the apps/web dev port per `CLAUDE.md` §
 * Quick Start. Production deployments MUST set the env var explicitly via
 * apphosting.yaml; the localhost-only default exists so a self-hoster's
 * first `npm run dev` works without manual configuration.
 *
 * Exported for unit tests.
 */
export function parseAllowedOrigins(raw: string | undefined = process.env.ALLOWED_ORIGINS): string[] {
    if (!raw) return ['http://localhost:9002'];
    const entries = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    return entries.length > 0 ? entries : ['http://localhost:9002'];
}

/**
 * Construct the Hono app with all middleware and routes wired.
 *
 * Exported as a factory (not a module-level `new Hono()`) so tests can
 * build a fresh app per test, and so `src/index.ts` stays dedicated to
 * the runtime `serve()` call.
 *
 * ## Middleware order matters
 *
 *   1. request-id — sets `c.var.requestId`; must run before anything that
 *      reads it (error-handler, rate-limit, handlers).
 *   2. CORS — scoped to `/api/v1/*`; runs before route handlers so preflight
 *      OPTIONS requests are answered immediately. Allowlist comes from
 *      ALLOWED_ORIGINS env var. See specs/client-caller-split.md.
 *   3. routes — each route opts into rate-limit per-endpoint via the
 *      `rateLimit(...)` middleware; no global rate limit.
 *   4. error-handler — installed via `app.onError` so it catches throws
 *      from handlers AND from middleware (rate-limit, request-id).
 */

export function app(): OpenAPIHono {
    const a = new OpenAPIHono();

    // 1. Request ID — before everything so downstream middleware and
    //    the error handler can bind it to log lines.
    a.use('*', requestId());

    // 2. CORS — allowlist for browser-direct calls. Allowlist comes from the
    //    ALLOWED_ORIGINS env var (comma-separated). See parseAllowedOrigins
    //    above and apps/core-api/apphosting.yaml. Phase 1 of the
    //    client-caller-split flip (specs/client-caller-split.md). Server-side
    //    RSC traffic via CORE_API_BASE_URL is same-process and unaffected by
    //    CORS. Scoped to /api/v1/* so health probes don't get the headers.
    a.use(
        '/api/v1/*',
        cors({
            origin: parseAllowedOrigins(),
            allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
            allowHeaders: [
                'Authorization',
                'Content-Type',
                'X-Request-ID',
                'Idempotency-Key',
            ],
            exposeHeaders: ['X-Request-ID'],
            credentials: true,
            maxAge: 7200,
        }),
    );

    // 3. Health + service identity. No rate limit (probes hit these).
    a.get('/', (c) =>
        c.json({
            service: 'vox-pop-core-api',
            version: '0.1.0',
            status: 'ok',
            requestId: c.get('requestId'),
        }),
    );
    a.get('/health', (c) =>
        c.json({
            ok: true,
            sha: process.env.COMMIT_SHA ?? 'dev',
            deployedAt: process.env.BUILD_TIME ?? null,
        }),
    );

    // 4. API routes.
    a.route('/api/v1/resolve', resolveRoute);
    a.route('/api/v1/prompts', promptsRoute);
    // Mount the replies sub-route on /api/v1/prompts so `/:promptId/replies`
    // composes with the existing `/:promptId` handler in promptsRoute.
    a.route('/api/v1/prompts', promptsRepliesRoute);
    // Users routes all mount at /api/v1/users; route files distinguish by
    // path tail (`/me` vs `/:handle` vs `/:handle/prompts` vs `/:handle/profile`).
    // Register the more specific `/me` mount FIRST so Hono prefers it over the
    // `/:handle` parameter match (handle="me" would otherwise hit usersRoute
    // and 404 on user lookup).
    // Register the more-specific `/me/call-forwarding` mount BEFORE the
    // `/users/me` mount so it takes precedence — handlers in usersMeRoute
    // don't expect a `/call-forwarding/...` sub-path, but registering more
    // specific first is the defensive pattern (and matches the precedent
    // set by registering `/me` before `/:handle` below).
    a.route('/api/v1/users/me/call-forwarding', callForwardingRoute);
    // Same defensive ordering as call-forwarding: register the more-specific
    // `/me/screening` mount before `/me` so it isn't shadowed by usersMeRoute.
    a.route('/api/v1/users/me/screening', screeningRoute);
    a.route('/api/v1/users/me', usersMeRoute);
    a.route('/api/v1/users', usersActionsRoute);
    a.route('/api/v1/users', usersRoute);
    a.route('/api/v1/users', usersPromptsRoute);
    a.route('/api/v1/users', usersProfileRoute);
    a.route('/api/v1/replies', repliesFeedRoute);
    a.route('/api/v1/replies', repliesSearchRoute);
    a.route('/api/v1/replies', repliesRoute);
    // All audio storage operations live under /api/v1/audio. Mount the
    // more-specific upload sub-routes BEFORE the proxy so they take
    // precedence — Hono dispatches by registration order.
    a.route('/api/v1/audio/upload-pending', audioUploadPendingRoute);
    a.route('/api/v1/audio/upload', audioUploadRoute);
    a.route('/api/v1/audio', audioRoute);
    // Connector control plane (Plan B) — uniform per-connector config.
    a.route('/api/v1/connectors', connectorsRoute);
    a.route('/api/v1/prompts/public', promptsPublicRoute);
    a.route('/api/v1/rss', rssParseRoute);
    a.route('/api/v1/organizations', organizationsRoute);
    a.route('/api/v1/people', peopleRoute);
    a.route('/api/v1/notifications', notificationsRoute);
    a.route('/api/v1/call-forwarding', callForwardingLookupRoute);
    a.route('/api/v1/system/replies', systemRepliesRoute);
    // Connector status-report (ingestion plane, system-auth) — connectors
    // report their owner-scoped status here; the user-facing config control
    // plane is the documented /api/v1/connectors/* surface.
    a.route('/api/v1/system/connectors', connectorsSystemRoute);
    // PR-F3b stage 1: apps/web's rate-limit shim calls this endpoint
    // (system-auth) instead of touching Firestore directly, so apps/web
    // doesn't need firebase-admin for rate-limiting.
    a.route('/api/v1/system/rate-limit', rateLimitCheckRoute);
    a.route('/api/v1/atproto', atprotoRoute);
    a.route('/api/v1/system/atproto-state', systemAtprotoStateRoute);
    a.route('/api/v1/system/atproto-session', systemAtprotoSessionRoute);
    a.route('/api/v1/system/auth', systemAuthMintRoute);
    a.route('/api/v1/system/users', systemBlueskyIdentityRoute);
    a.route('/api/v1/system/atproto', systemAtprotoSigninRoute);

    // 5. OpenAPI document — served at `/openapi.json`. Only routes
    //    registered via `app.openapi(createRoute(...), handler)` appear
    //    in the spec. Public-doc scope: `/users`, `/prompts`, `/replies`,
    //    `/auth`. Transport/utility/system routes intentionally stay
    //    plain-Hono. See `specs/drafts/openapi-generation.md`.
    a.doc('/openapi.json', { openapi: '3.0.0', info: OPENAPI_INFO, tags: [...OPENAPI_TAGS] });

    // 6. Error handler — last, via `onError` so it catches throws from
    //    any middleware or handler above.
    a.onError(errorHandler);

    return a;
}
