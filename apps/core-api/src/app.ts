import { Hono } from 'hono';
import { requestId } from './middleware/request-id.js';
import { errorHandler } from './middleware/error-handler.js';
import { handlesRoute } from './routes/handles.js';
import { resolveRoute } from './routes/resolve.js';

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
 *   2. routes — each route opts into rate-limit per-endpoint via the
 *      `rateLimit(...)` middleware; no global rate limit.
 *   3. error-handler — installed via `app.onError` so it catches throws
 *      from handlers AND from middleware (rate-limit, request-id).
 */

export function app(): Hono {
    const a = new Hono();

    // 1. Request ID — before everything so downstream middleware and
    //    the error handler can bind it to log lines.
    a.use('*', requestId());

    // 2. Health + service identity. No rate limit (probes hit these).
    a.get('/', (c) =>
        c.json({
            service: 'vox-pop-core-api',
            version: '0.1.0',
            status: 'ok',
            requestId: c.get('requestId'),
        }),
    );
    a.get('/health', (c) => c.json({ ok: true }));

    // 3. API routes.
    a.route('/api/v1/handles', handlesRoute);
    a.route('/api/v1/resolve', resolveRoute);

    // 4. Error handler — last, via `onError` so it catches throws from
    //    any middleware or handler above.
    a.onError(errorHandler);

    return a;
}
