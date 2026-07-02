/**
 * Antiphony core-api — Hono HTTP service.
 *
 * The standalone `/api/v1/*` backend. Route wiring, middleware order, and
 * the OpenAPI document all live in `app.ts`; this file is only the runtime
 * `serve()` entry point.
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
