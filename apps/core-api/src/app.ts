import { OpenAPIHono } from '@hono/zod-openapi';
import { OPENAPI_INFO, OPENAPI_TAGS } from './lib/openapi-info.js';
import { requestId } from './middleware/request-id.js';
import { securityHeaders } from './middleware/security-headers.js';
import { errorHandler } from './middleware/error-handler.js';
import { postsRoute } from './adapters/inbound/rest/posts.js';
import { audioRoute } from './adapters/inbound/rest/audio.js';
import { audioUploadRoute } from './adapters/inbound/rest/audio-upload.js';
import { systemProcessAudioRoute } from './adapters/inbound/rest/system-process-audio.js';
import { xrpcRoute } from './adapters/inbound/xrpc/index.js';
import { servicesFor } from './composition.js';
import { dataPresence, type R2ListLike } from './lib/data-presence.js';

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
 *      reads it (error-handler, rate-limit, handlers).
 *   2. security-headers — global API-tier hardening (strict CSP, frame-deny,
 *      Cross-Origin-Resource-Policy); see middleware/security-headers.ts.
 *      Applied to every response, errors included.
 *   3. infra routes — `/`, `/health`, `/openapi.json`. No auth, so probes
 *      and uptime checks reach them.
 *   4. routes — each route opts into rate-limit per-endpoint via the
 *      `rateLimit(...)` middleware; no global rate limit. Gated routes also
 *      carry `requireAuth()` / `requireServiceToken()`, which is where the
 *      per-tenant app-DID custody check happens (middleware/auth.ts).
 *   5. error-handler — installed via `app.onError` so it catches throws
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
    a.get('/health', async (c) => {
        const bindings = c.env as Record<string, unknown> | undefined;
        const services = servicesFor(bindings);
        return c.json({
            ok: true,
            sha: process.env.COMMIT_SHA ?? 'dev',
            deployedAt: process.env.BUILD_TIME ?? null,
            // Which bindings are actually wired. The Firestore -> Neon cutover
            // is a configuration change, so "which store is this revision
            // talking to" stops being answerable from the commit alone — and
            // that is precisely the question during a migration.
            backend: services.backend,
            // Whether those bindings HAVE anything, which is a different
            // question and the one that went unanswered for 20 minutes while
            // this endpoint reported ok:true over an empty Neon and an empty
            // R2. See lib/data-presence.ts for the incident; the short version
            // is that `backend` was correct throughout and useless.
            //
            // `ok` deliberately stays true when these are `empty`: an empty
            // deployment is a legitimate state, and a health check that fails
            // for it cannot be used by the thing that provisions it. The signal
            // is the field, not the status code.
            ...(await dataPresence({
                sql: services.sql,
                bucket: bindings?.BLOBS as R2ListLike | undefined,
            })),
        });
    });

    // 4. API routes.
    //
    // There is no origin lock any more. It existed to prove a request arrived
    // through Cloudflare rather than at Cloud Run's still-public `*.run.app`
    // hostname — a gap that does not exist on Workers, where there is no
    // origin behind the edge to bypass. Deleted with the runtime it defended.
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

    // The XRPC inbound adapter — the same domain services as `/api/v1/*`,
    // addressed by method NSID and answering in the AT Protocol error dialect.
    // It carries its own `onError` (see adapters/inbound/xrpc/errors.ts); Hono
    // dispatches throws from these routes there rather than to the REST handler
    // installed below, which is what keeps the two envelopes apart.
    a.route('/xrpc', xrpcRoute());

    // 5. OpenAPI document — served at `/openapi.json`. Only routes
    //    registered via `app.openapi(createRoute(...), handler)` appear
    //    in the spec. Public-doc scope: `/posts` and `/audio`.
    //    Transport/utility/system routes intentionally stay plain-Hono.
    a.doc('/openapi.json', { openapi: '3.0.0', info: OPENAPI_INFO, tags: [...OPENAPI_TAGS] });

    // 6. Error handler — last, via `onError` so it catches throws from
    //    any middleware or handler above.
    a.onError(errorHandler);

    return a;
}
