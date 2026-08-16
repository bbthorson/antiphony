import { OpenAPIHono } from '@hono/zod-openapi';
import { OPENAPI_INFO, OPENAPI_TAGS } from './lib/openapi-info.js';
import { requestId } from './middleware/request-id.js';
import { securityHeaders } from './middleware/security-headers.js';
import { errorHandler } from './middleware/error-handler.js';
import { postsRoute } from './adapters/inbound/rest/posts.js';
import { audioRoute } from './adapters/inbound/rest/audio.js';
import { audioUploadRoute } from './adapters/inbound/rest/audio-upload.js';
import { systemProcessAudioRoute } from './adapters/inbound/rest/system-process-audio.js';
import { originLock } from './middleware/origin-lock.js';

/**
 * ## No CORS middleware — deliberately
 *
 * Antiphony is headless: every caller is an application holding a service
 * token, and a service token authenticates the *app*, not a person, so it can
 * never reach a browser bundle. Integrations therefore call their own origin
 * and a server-side hop forwards to core-api (see `apps/reference/server/
 * dev-bff.ts` for the reference shape). A server-to-server caller is not
 * subject to the same-origin policy at all, so CORS gates nothing on that path.
 *
 * The one surface a browser does touch directly is the anonymous audio proxy,
 * `GET /api/v1/audio`, via `<audio src=…>`. That is a **no-cors media load**:
 * it is governed by `Cross-Origin-Resource-Policy` (set to `cross-origin` in
 * middleware/security-headers.ts, and load-bearing), not by CORS. Removing the
 * CORS middleware does not affect it.
 *
 * The remaining case CORS would cover — a browser `fetch()` of that proxy —
 * does not work today regardless: the route 302s to a signed Cloud Storage
 * URL, and following that redirect from a browser needs CORS on the *bucket*.
 * An allowlist here would have permitted the first hop of a request that then
 * fails at the second.
 *
 * So the middleware, its `ALLOWED_ORIGINS` env var, and its `credentials: true`
 * (which advertised cookie auth this API does not have) are gone. If a genuine
 * browser-direct integration ever lands, this is the place it comes back — with
 * the bucket's CORS configured to match.
 */

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
 *      reads it (error-handler, origin-lock, rate-limit, handlers).
 *   2. security-headers — global API-tier hardening (strict CSP, frame-deny,
 *      Cross-Origin-Resource-Policy); see middleware/security-headers.ts.
 *      Applied to every response, errors included.
 *   3. infra routes — `/`, `/health`, `/openapi.json`. Registered before the
 *      origin lock and outside its `/api/v1/*` scope, so they answer on the
 *      `*.run.app` hostname too. The deploy workflow's pre-promotion smoke
 *      test depends on that.
 *   4. origin-lock — `/api/v1/*` only; rejects anything that did not come
 *      through Cloudflare. Must run before the route handlers, and after
 *      request-id so its refusals carry a request id.
 *   5. routes — each route opts into rate-limit per-endpoint via the
 *      `rateLimit(...)` middleware; no global rate limit.
 *   6. error-handler — installed via `app.onError` so it catches throws
 *      from handlers AND from middleware (rate-limit, request-id).
 *
 * There is no CORS step — see the note above this factory for why.
 */

export function app(): OpenAPIHono {
    const a = new OpenAPIHono();

    // 1. Request ID — before everything so downstream middleware and
    //    the error handler can bind it to log lines.
    a.use('*', requestId());

    // 2. Security headers — strict API-tier CSP + hardening on every response.
    a.use('*', securityHeaders());

    // 3. Health + service identity. No rate limit (probes hit these).
    a.get('/', (c) =>
        c.json({
            service: 'antiphony-core-api',
            // Single source of truth for the API contract version — see
            // specs/api-versioning.md. Never re-type the literal here.
            version: OPENAPI_INFO.version,
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

    // 4. Origin lock — every `/api/v1/*` request must carry the header
    //    Cloudflare injects, proving it came through the CDN rather than
    //    straight at the still-public `*.run.app` hostname. Scoped to the API
    //    prefix on purpose: the infra routes above stay open on every hostname
    //    because the deploy workflow smoke-tests `/health` on a candidate
    //    revision's tag URL, which is by definition not yet behind Cloudflare.
    //    No-op while ANTIPHONY_ORIGIN_SECRET is unset — see middleware/origin-lock.ts
    //    for why this one fails OPEN when the rest of this codebase fails closed.
    a.use('/api/v1/*', originLock());

    // 5. API routes.
    // Antiphony canonical audio-post surface (`dev.antiphony.audio.post`).
    a.route('/api/v1/posts', postsRoute);
    // All audio storage operations live under /api/v1/audio. Mount the
    // more-specific upload sub-route BEFORE the proxy so it takes
    // precedence — Hono dispatches by registration order.
    a.route('/api/v1/audio/upload', audioUploadRoute);
    a.route('/api/v1/audio', audioRoute);
    // The queue/Cloud Tasks callback — the only remaining `/system/*` route.
    //
    // Six others were removed in the dead-route sweep: the OAuth state and
    // session stores, DID→uid signin, bluesky-identity, session-cookie minting,
    // and the rate-limit check. Every one had been re-homed in the Vox Pop BFF
    // (Stream 4 F7 A1/A2/G1/G2) and had no caller left. See
    // specs/core-bff-boundary.md § Surface disposition.
    a.route('/api/v1/system/process-audio', systemProcessAudioRoute);

    // 6. OpenAPI document — served at `/openapi.json`. Only routes
    //    registered via `app.openapi(createRoute(...), handler)` appear
    //    in the spec. Public-doc scope: `/posts` and `/audio`.
    //    Transport/utility/system routes intentionally stay plain-Hono.
    a.doc('/openapi.json', { openapi: '3.0.0', info: OPENAPI_INFO, tags: [...OPENAPI_TAGS] });

    // 7. Error handler — last, via `onError` so it catches throws from
    //    any middleware or handler above.
    a.onError(errorHandler);

    return a;
}
