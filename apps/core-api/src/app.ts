import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requestId } from './middleware/request-id.js';
import { errorHandler } from './middleware/error-handler.js';
import { handlesRoute } from './routes/handles.js';
import { resolveRoute } from './routes/resolve.js';
import { promptsRoute } from './routes/prompts.js';
import { promptsRepliesRoute } from './routes/prompts-replies.js';
import { usersPromptsRoute } from './routes/users-prompts.js';
import { peopleRoute } from './routes/people.js';
import { peopleListRoute } from './routes/people-list.js';
import { peopleRepliesRoute } from './routes/people-replies.js';
import { repliesSearchRoute } from './routes/replies-search.js';
import { repliesRoute } from './routes/replies.js';
import { usersRoute } from './routes/users.js';
import { usersMeRoute } from './routes/users-me.js';
import { usersActionsRoute } from './routes/users-actions.js';
import { usersProfileRoute } from './routes/users-profile.js';
import { organizationsSlugRoute } from './routes/organizations-slug.js';
import { organizationsSlugProfileRoute } from './routes/organizations-slug-profile.js';
import { organizationsRoute } from './routes/organizations.js';
import { audioRoute } from './routes/audio.js';
import { promptsPublicRoute } from './routes/prompts-public.js';
import { parseRssRoute } from './routes/parse-rss.js';
import { onboardingRoute } from './routes/onboarding.js';
import { uploadsAudioRoute } from './routes/uploads-audio.js';
import { uploadsPendingRoute } from './routes/uploads-pending.js';
import { inboxRoute } from './routes/inbox.js';
import { notificationsRoute } from './routes/notifications.js';

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

export function app(): Hono {
    const a = new Hono();

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
    a.get('/health', (c) => c.json({ ok: true }));

    // 4. API routes.
    a.route('/api/v1/handles', handlesRoute);
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
    a.route('/api/v1/users/me', usersMeRoute);
    a.route('/api/v1/users', usersActionsRoute);
    a.route('/api/v1/users', usersRoute);
    a.route('/api/v1/users', usersPromptsRoute);
    a.route('/api/v1/users', usersProfileRoute);
    // Same pattern for organizations slug routes — more specific `/slug/*`
    // prefix MUST register first so a request like `/organizations/slug/abc`
    // lands on the slug handler rather than the `/:orgId` catch-all in
    // organizationsRoute.
    a.route('/api/v1/organizations/slug', organizationsSlugRoute);
    a.route('/api/v1/organizations/slug', organizationsSlugProfileRoute);
    a.route('/api/v1/organizations', organizationsRoute);
    // peopleRoute owns `/` (top-level) + `/:handle/notes`. Sibling routes
    // (peopleListRoute → /list, peopleRepliesRoute → /:handle/replies)
    // share the same prefix; Hono dispatches by path tail.
    a.route('/api/v1/people', peopleRoute);
    a.route('/api/v1/people', peopleListRoute);
    a.route('/api/v1/people', peopleRepliesRoute);
    a.route('/api/v1/replies', repliesSearchRoute);
    a.route('/api/v1/replies', repliesRoute);
    a.route('/api/v1/audio', audioRoute);
    a.route('/api/v1/prompts/public', promptsPublicRoute);
    a.route('/api/v1/utils/parse-rss', parseRssRoute);
    a.route('/api/v1/onboarding', onboardingRoute);
    a.route('/api/v1/uploads/audio', uploadsAudioRoute);
    a.route('/api/v1/uploads/pending', uploadsPendingRoute);
    a.route('/api/v1/inbox', inboxRoute);
    a.route('/api/v1/notifications', notificationsRoute);

    // 5. Error handler — last, via `onError` so it catches throws from
    //    any middleware or handler above.
    a.onError(errorHandler);

    return a;
}
