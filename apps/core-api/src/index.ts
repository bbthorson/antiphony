/**
 * Vox Pop core-api — Hono HTTP service.
 *
 * This is the Phase 4a deployment target: the `/api/v1/*` surface extracted
 * from `apps/web` and hosted as a standalone backend. See
 * [`specs/decoupling-migration.md`](../../../specs/decoupling-migration.md)
 * § Phase 4 for context.
 *
 * **PR #1 scaffold scope**: this file serves only health and service-identity
 * endpoints. Real `/api/v1/*` handlers, middleware (error-handler, rate-limit,
 * request-id), auth bridge, and the Firebase-wired `CoreServices` binding
 * land in subsequent PRs. That staging keeps the deployment wiring separate
 * from the route migration risk.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

/**
 * GET / — service identity. Used as a trivial liveness / "did the deploy
 * actually take" check from a browser. Intentionally returns a minimal
 * payload so it can be smoke-tested without tooling.
 */
app.get('/', (c) => {
    return c.json({
        service: 'vox-pop-core-api',
        version: '0.1.0',
        status: 'ok',
    });
});

/**
 * GET /health — liveness probe. App Hosting's default probe calls the root
 * path, but exposing `/health` explicitly keeps room for a future readiness
 * probe that checks Firestore/Auth connectivity without coupling to the
 * root-path response shape.
 */
app.get('/health', (c) => {
    return c.json({ ok: true });
});

/**
 * Bind to the port Cloud Run / App Hosting injects via `PORT`. Falls back to
 * 8080 for local development (`npm run dev`).
 */
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

serve(
    {
        fetch: app.fetch,
        port,
    },
    (info) => {
        console.log(`[core-api] listening on http://localhost:${info.port}`);
    },
);
