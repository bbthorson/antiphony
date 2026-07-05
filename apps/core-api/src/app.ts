import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { OPENAPI_INFO, OPENAPI_TAGS } from './lib/openapi-info.js';
import { requestId } from './middleware/request-id.js';
import { securityHeaders } from './middleware/security-headers.js';
import { errorHandler } from './middleware/error-handler.js';
import { postsRoute } from './adapters/inbound/rest/posts.js';
import { actorsRoute } from './adapters/inbound/rest/actors.js';
import { usersRoute } from './adapters/inbound/rest/users.js';
import { usersMeRoute } from './adapters/inbound/rest/users-me.js';
import { usersProfileRoute } from './adapters/inbound/rest/users-profile.js';
import { audioRoute } from './adapters/inbound/rest/audio.js';
import { audioUploadRoute } from './adapters/inbound/rest/audio-upload.js';
import { rateLimitCheckRoute } from './adapters/inbound/rest/rate-limit-check.js';
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
 * env var is unset or all entries are empty, falls back to the reference
 * app's dev origin (`http://localhost:3002` — see apps/reference/vite.config.ts).
 * Production deployments MUST set the env var explicitly via apphosting.yaml;
 * the localhost-only default exists so a self-hoster's first `npm run dev`
 * works without manual configuration.
 *
 * Exported for unit tests.
 */
export function parseAllowedOrigins(raw: string | undefined = process.env.ALLOWED_ORIGINS): string[] {
    // Local-dev fallback when ALLOWED_ORIGINS is unset: apps/reference
    // (:3002), whose browser-direct audio upload (POST /api/v1/audio/upload)
    // needs CORS even in dev.
    const fallback = ['http://localhost:3002'];
    if (!raw) return fallback;
    const entries = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    return entries.length > 0 ? entries : fallback;
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
 *   2. security-headers — global API-tier hardening (strict CSP, frame-deny,
 *      etc.); see middleware/security-headers.ts. Before CORS so even preflight
 *      and error responses carry the headers.
 *   3. CORS — scoped to `/api/v1/*`; runs before route handlers so preflight
 *      OPTIONS requests are answered immediately. Allowlist comes from
 *      ALLOWED_ORIGINS env var.
 *   4. routes — each route opts into rate-limit per-endpoint via the
 *      `rateLimit(...)` middleware; no global rate limit.
 *   5. error-handler — installed via `app.onError` so it catches throws
 *      from handlers AND from middleware (rate-limit, request-id).
 */

export function app(): OpenAPIHono {
    const a = new OpenAPIHono();

    // 1. Request ID — before everything so downstream middleware and
    //    the error handler can bind it to log lines.
    a.use('*', requestId());

    // 2. Security headers — strict API-tier CSP + hardening on every response.
    a.use('*', securityHeaders());

    // 3. CORS — allowlist for browser-direct calls. Allowlist comes from the
    //    ALLOWED_ORIGINS env var (comma-separated); see parseAllowedOrigins
    //    above and apphosting.yaml. Server-to-server callers are unaffected.
    //    Scoped to /api/v1/* so health probes don't get the headers.
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

    // 4. Health + service identity. No rate limit (probes hit these).
    a.get('/', (c) =>
        c.json({
            service: 'antiphony-core-api',
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

    // 5. API routes.
    // Antiphony canonical audio-post surface (`dev.antiphony.audio.post`).
    a.route('/api/v1/posts', postsRoute);
    // The optional actor↔DID mapping a connecting app may register
    // (specs/service-auth.md). Not the user/profile surface — B4-prep.
    a.route('/api/v1/actors', actorsRoute);
    // Users routes all mount at /api/v1/users; route files distinguish by
    // path tail (`/me` vs `/:handle` vs `/:handle/profile`). Register the more
    // specific `/me` mount FIRST so Hono prefers it over the `/:handle`
    // parameter match (handle="me" would otherwise hit usersRoute and 404 on
    // user lookup).
    a.route('/api/v1/users/me', usersMeRoute);
    a.route('/api/v1/users', usersRoute);
    a.route('/api/v1/users', usersProfileRoute);
    // All audio storage operations live under /api/v1/audio. Mount the
    // more-specific upload sub-route BEFORE the proxy so it takes
    // precedence — Hono dispatches by registration order.
    a.route('/api/v1/audio/upload', audioUploadRoute);
    a.route('/api/v1/audio', audioRoute);
    // System-auth'd rate-limit check for trusted sibling services (e.g. the
    // Vox Pop BFF) so they can rate-limit without touching Firestore directly.
    a.route('/api/v1/system/rate-limit', rateLimitCheckRoute);
    a.route('/api/v1/system/atproto-state', systemAtprotoStateRoute);
    a.route('/api/v1/system/atproto-session', systemAtprotoSessionRoute);
    a.route('/api/v1/system/auth', systemAuthMintRoute);
    a.route('/api/v1/system/users', systemBlueskyIdentityRoute);
    a.route('/api/v1/system/atproto', systemAtprotoSigninRoute);

    // 6. OpenAPI document — served at `/openapi.json`. Only routes
    //    registered via `app.openapi(createRoute(...), handler)` appear
    //    in the spec. Public-doc scope: `/users`, `/resolve`, `/posts`,
    //    `/actors`, `/audio`, `/atproto`. Transport/utility/system routes
    //    intentionally stay plain-Hono.
    a.doc('/openapi.json', { openapi: '3.0.0', info: OPENAPI_INFO, tags: [...OPENAPI_TAGS] });

    // 7. Error handler — last, via `onError` so it catches throws from
    //    any middleware or handler above.
    a.onError(errorHandler);

    return a;
}
