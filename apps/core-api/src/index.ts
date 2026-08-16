/**
 * Antiphony core-api — Hono HTTP service.
 *
 * The standalone `/api/v1/*` backend. Route wiring, middleware order, and
 * the OpenAPI document all live in `app.ts`; this file is only the runtime
 * `serve()` entry point.
 */

// FIRST, and for side effects: installs the Firebase bindings, the ffmpeg stage
// adapters, and the Cloud Tasks dispatcher into their respective seams. Must
// precede any import that could reach `servicesFor()`. See `native.ts`.
import './native.js';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { app as createApp } from './app.js';
import { validateAllPins, checkTenantRegistryDrift } from './lib/app-did.js';
import { parseAppTokens } from './middleware/service-auth.js';
import { APP_CONFIG } from './lib/app-config.js';
import { logger } from './lib/logger.js';
import { installShutdownHandlers } from './lib/shutdown.js';

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
    const server = serve({ fetch: app.fetch, port }, (info) => {
        logger.info({ port: info.port }, '[core-api] listening');
    });

    // Installed only after `serve()` returns, so a SIGTERM arriving during the
    // boot gate above is not caught here. That is deliberate: nothing is
    // listening yet, so the right response to a signal then is the default one —
    // die immediately — not a drain of zero connections.
    installShutdownHandlers({ server, logger });
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
