import type { OpenAPIHono } from '@hono/zod-openapi';
import { app as createApp } from './app.js';
import { validateAllPins, checkTenantRegistryDrift } from './lib/app-did.js';
import { parseAppTokens } from './middleware/service-auth.js';
import { APP_CONFIG } from './lib/app-config.js';
import { logger } from './lib/logger.js';
import { servicesFor } from './composition.js';
import { sweepExpired } from './adapters/outbound/postgres/sweep.js';
import type {
    ExecutionContext,
    ExportedHandler,
    ScheduledController,
} from './lib/workers-runtime.js';

/**
 * Antiphony core-api — Cloudflare Workers entry point.
 *
 * The counterpart to `src/index.ts`, which is the Node/Cloud Run one. Route
 * wiring, middleware order, and the OpenAPI document all live in `app.ts` and
 * are shared verbatim; this file is only the runtime seam.
 *
 * Note what it deliberately does NOT import: `./native.js`. That module carries
 * `firebase-admin`, `ffmpeg-static`, and `google-auth-library`, none of which
 * can run here. See `native.ts` for the whole argument, and `composition.ts`
 * for what a Worker gets instead — bindings that are mandatory rather than
 * optional, so a misconfigured deployment fails loudly at its first request
 * instead of quietly talking to the wrong store.
 *
 * ## Three handlers
 *
 *   - `fetch`     — the HTTP surface, unchanged from Cloud Run.
 *   - `scheduled` — the cron. Drives `antiphony_sweep_expired()`, which has had
 *                   no caller since it shipped with the schema.
 *   - `queue`     — NOT here yet; it lands with the Queues cutover in 3c,
 *                   alongside `PROCESSING_QUEUE` on the producing side. Until
 *                   then a Worker deployment has no durable dispatch and posts
 *                   with pending stages log through the noop dispatcher.
 */

/**
 * Built once per isolate rather than per request.
 *
 * `app()` registers every route, compiles the Hono router, and builds the
 * OpenAPI document; doing that per request would put the whole routing table's
 * construction in the latency of each one. The isolate is the natural lifetime
 * — it is the same reason `servicesFor` memoises on the env object.
 */
let cachedApp: OpenAPIHono | undefined;
function workerApp(): OpenAPIHono {
    cachedApp ??= createApp();
    return cachedApp;
}

/**
 * The interim boot gate.
 *
 * ## What this is standing in for
 *
 * On Cloud Run, `index.ts` runs `validateAllPins` before `serve()` and
 * `process.exit(1)`s on failure, so `getAppDid()` — a synchronous accessor that
 * serves only from that snapshot — can never answer with a DID whose custody we
 * have not proven. **Workers have no boot phase**, so that ordering has to come
 * from somewhere else.
 *
 * This is the smallest thing that preserves the actual property: validate the
 * whole pin set once per isolate, before the first request is served, and
 * fail closed if it does not validate. `getAppDid()` stays synchronous and
 * `packages/core` stays untouched.
 *
 * ## It is explicitly NOT the designed replacement
 *
 * Step 3d replaces this with four mechanisms — a CI deploy gate, lazy
 * *per-tenant* validation folded into the auth middleware, a KV cache that
 * distinguishes positive disproof from unreachability, and an hourly drift
 * cron. Two things this interim version gets wrong, both of which 3d fixes and
 * neither of which is worse than what Cloud Run does today:
 *
 *   - **Blast radius is global.** `validateAllPins` throws on the first
 *     failure, so one bad tenant fails every request in the isolate. Cloud Run
 *     has exactly this bug; per-tenant validation is what fixes it.
 *   - **A transient `did:web` outage is treated as disproof.** Absence of
 *     evidence is not evidence of absence, and the cache split in 3d is what
 *     tells them apart. Mitigated here only by retrying: a rejected promise is
 *     cleared rather than memoised, so a blip costs one failed request rather
 *     than poisoning the isolate for its lifetime.
 *
 * See specs/cloudflare-migration.md § The boot gate.
 */
let pinGate: Promise<void> | undefined;

function ensurePinsValidated(): Promise<void> {
    pinGate ??= (async () => {
        if (!APP_CONFIG.PDS_HOST) {
            logger.warn(
                '[core-api] ANTIPHONY_PDS_HOST unset — app-DID custody host-match check is DISABLED (endpoint existence still required)',
            );
        }
        await validateAllPins({ expectedPdsHost: APP_CONFIG.PDS_HOST });
        checkTenantRegistryDrift(parseAppTokens().map((a) => a.appId));
    })().catch((err) => {
        // Clear before rethrowing, so the NEXT request retries rather than
        // inheriting this rejection. A memoised rejected promise would turn a
        // five-second did:web timeout into a permanently broken isolate — the
        // failure mode the deploy workflow already complains about ("a deploy
        // can fail for a reason that has nothing to do with this commit").
        pinGate = undefined;
        throw err;
    });
    return pinGate;
}

export default {
    async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
        try {
            await ensurePinsValidated();
        } catch (err) {
            // Fail closed, with the same meaning `process.exit(1)` had on Cloud
            // Run: we cannot prove custody of the authority we would mint
            // `at://` uris under, so we serve nothing. 503 rather than 500 —
            // it is a readiness statement, and it is retryable.
            logger.error({ err }, '[core-api] app-DID pin validation failed; refusing to serve');
            return new Response(
                JSON.stringify({ success: false, error: { message: 'Service unavailable' } }),
                { status: 503, headers: { 'content-type': 'application/json' } },
            );
        }
        // Hono's `fetch` types `env` as an object; the handler signature keeps
        // it `unknown` so no second description of the bindings exists. The
        // cast is the one place those two meet.
        return workerApp().fetch(request, env as Record<string, unknown>, ctx);
    },

    /**
     * Cron. Wired in `wrangler.core-api.jsonc`; see that file for the schedule
     * and why it is hourly.
     *
     * The pin gate is NOT awaited here. This handler mints no `at://` uris and
     * touches no records — it runs one maintenance statement — so gating it on
     * a `did:web` fetch would mean an unreachable DID document stops disk
     * reclamation, which are unrelated concerns. 3d adds a *separate* drift
     * revalidation on this same trigger; that one is about pins and will do its
     * own resolving.
     */
    async scheduled(_event: ScheduledController, env: unknown, _ctx: ExecutionContext): Promise<void> {
        const { sql, backend } = servicesFor(env as Record<string, unknown>);
        if (!sql) {
            // Firestore has native TTL, so there is nothing to sweep. Logged
            // rather than silent: on a Worker this means the database binding
            // is missing, which is a misconfiguration wearing a no-op's face.
            logger.warn({ backend }, '[sweep] no SQL backend bound — nothing to sweep');
            return;
        }
        await sweepExpired(sql, logger);
    },
} satisfies ExportedHandler;
