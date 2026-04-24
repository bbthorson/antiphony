/**
 * Vox Pop core-api — Hono HTTP service.
 *
 * Phase 4a deployment target: the `/api/v1/*` surface extracted from
 * `apps/web` and hosted as a standalone backend. See
 * [`specs/decoupling-migration.md`](../../../specs/decoupling-migration.md)
 * § Phase 4 for context.
 *
 * ## Current state (PR #2)
 *
 * Middleware wired: request-id propagation, error handling, rate limiting.
 * Firebase Admin bootstrap available on first query. One real endpoint:
 * `GET /api/v1/handles` (public sitemap enumeration).
 *
 * ## Planned (PR #3+)
 *
 * Remaining 65 route handlers port incrementally from
 * `apps/web/src/app/api/v1/*`. Auth middleware + bearer-token bridge lands
 * alongside the first authenticated endpoint. The `CORE_API_BASE_URL`
 * env-var flip in apps/web comes once enough endpoints are live.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { app as createApp } from './app.js';

const app = createApp();

/** Bind to the port Cloud Run / App Hosting injects via `PORT`. */
const port = Number(process.env.PORT) || 8080;

serve(
    {
        fetch: app.fetch,
        port,
    },
    (info) => {
        console.log(`[core-api] listening on http://localhost:${info.port}`);
    },
);

// Re-export the app factory for tests.
export { createApp };
export type AppType = Hono;
