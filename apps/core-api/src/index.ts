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
import { validateAllPins, checkTenantRegistryDrift } from './lib/app-did.js';
import { parseAppTokens } from './middleware/service-auth.js';
import { APP_CONFIG } from './lib/app-config.js';
import { logger } from './lib/logger.js';

/** Bind to the port Cloud Run / App Hosting injects via `PORT`. */
const port = Number(process.env.PORT) || 8080;

/**
 * Boot gate. Validate every configured app-DID pin against its `did:web`
 * document (custody check) and snapshot the result BEFORE serving traffic —
 * fail-closed, so the process never answers a request able to mint an `at://`
 * uri whose authority we haven't proven points back at us. This lives here,
 * not in the `app()` factory, so tests build the app without network I/O.
 */
async function main(): Promise<void> {
    if (!APP_CONFIG.PDS_HOST) {
        logger.warn(
            '[core-api] ANTIPHONY_PDS_HOST unset — app-DID custody host-match check is DISABLED (endpoint existence still required)',
        );
    }
    await validateAllPins({ expectedPdsHost: APP_CONFIG.PDS_HOST });

    // Warn (don't fail) on drift between the auth-token and app-DID registries —
    // a tenant configured in one but not the other is a misconfiguration surfaced
    // at boot rather than at its first request.
    checkTenantRegistryDrift(parseAppTokens().map((a) => a.appId));

    const app = createApp();
    serve({ fetch: app.fetch, port }, (info) => {
        logger.info({ port: info.port }, '[core-api] listening');
    });
}

main().catch((err) => {
    // Fail-closed: an unvalidated pin (or any boot error) must stop the process
    // rather than start serving with authority we haven't proven.
    logger.error({ err }, '[core-api] boot failed');
    process.exit(1);
});

// Re-export the app factory for tests.
export { createApp };
export type AppType = Hono;
