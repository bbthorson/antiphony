import type { OpenAPIHono } from '@hono/zod-openapi';
import { app as createApp } from './app.js';
import { revalidateAllPins, type PinCacheKV } from './lib/app-did.js';
import { APP_CONFIG, assertRequiredConfig } from './lib/app-config.js';
import { logger } from './lib/logger.js';
import { dataPresence, isAudioBlackout, type R2ListLike } from './lib/data-presence.js';
import { servicesFor } from './composition.js';
import { sweepExpired } from './adapters/outbound/postgres/sweep.js';
import { installDurableDispatcher } from './lib/audio-processing.js';
import { queueResolver } from './adapters/outbound/dispatch/queue.js';
import { runProcessingJob, shouldRetry } from './lib/process-audio-job.js';
import type {
    ExecutionContext,
    ExportedHandler,
    MessageBatch,
    ScheduledController,
} from './lib/workers-runtime.js';

/**
 * The producing half of the queue seam, installed at module load the way
 * `native.ts` installs the Cloud Tasks one under Node.
 *
 * The resolver reads `PROCESSING_QUEUE` off the per-invocation `env` rather
 * than closing over a binding, because bindings do not exist at
 * module-evaluation time — the same constraint that made the composition root
 * a factory.
 */
installDurableDispatcher(queueResolver(logger));

/**
 * Refuse to start without the configuration a deployment must carry.
 *
 * At module scope on purpose: this is the only "startup" a Worker has, and a
 * throw here fails the isolate rather than the request, so the deploy's smoke
 * test sees it immediately instead of a consumer discovering it later through a
 * post that hydrates with no audio. See `assertRequiredConfig` for why that
 * specific failure is what this defends against, and why it is not a revival of
 * the boot gate the migration deleted.
 */
assertRequiredConfig();

/**
 * The rate-limit bucket, re-exported so the runtime can find it.
 *
 * A Durable Object class has to be a named export of the Worker's entry module
 * — that is how `wrangler.jsonc`'s `durable_objects.bindings[].class_name`
 * resolves. The implementation lives with the other outbound adapters, where it
 * belongs; this line is the wiring.
 */
export { RateLimiter } from './adapters/outbound/durable-objects/rate-limiter.js';

/**
 * Antiphony core-api — Cloudflare Workers entry point.
 *
 * The counterpart to `src/index.ts`, which is the Node/Cloud Run one. Route
 * wiring, middleware order, and the OpenAPI document all live in `app.ts` and
 * are shared verbatim; this file is only the runtime seam.
 *
 * Note what it deliberately does NOT import: `./native.js`. That module carries
 * `firebase-admin` and `google-auth-library`, neither of which can run here. See
 * `native.ts` for the whole argument, and `composition.ts`
 * for what a Worker gets instead — bindings that are mandatory rather than
 * optional, so a misconfigured deployment fails loudly at its first request
 * instead of quietly talking to the wrong store.
 *
 * ## Three handlers
 *
 *   - `fetch`     — the HTTP surface, unchanged from Cloud Run.
 *   - `scheduled` — the cron. Drives `antiphony_sweep_expired()`, which has had
 *                   no caller since it shipped with the schema.
 *   - `queue`     — the audio-processing consumer, replacing the Cloud Tasks
 *                   push at `POST /api/v1/system/process-audio`. That route
 *                   stays mounted as the manual re-drive path.
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

export default {
    /**
     * ## There is no boot gate here, and that is the design
     *
     * On Cloud Run, `index.ts` proves every pin before `serve()` and
     * `process.exit(1)`s on failure. Workers have no boot phase, and the
     * replacement is deliberately not "do the same thing on the first request":
     * that would keep the property this codebase's own analysis says the boot
     * gate has by accident rather than by design — one bad tenant failing every
     * other tenant's requests, because `validateAllPins` throws on the first
     * failure.
     *
     * Custody is proven per tenant, in the auth middleware, which is the
     * tenancy boundary and already resolves `originAppId`. Every route that can
     * mint an `at://` uri carries `requireAuth()` or `requireServiceToken()`;
     * the one anonymous route, the audio proxy, takes a blob path and mints
     * nothing. See `middleware/auth.ts` § Why the pin check lives here, and
     * specs/cloudflare-migration.md § The boot gate.
     */
    async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
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
        const bindings = env as Record<string, unknown>;

        // Mechanism 4 of the boot-gate replacement: revalidate every pin off
        // the request path, purely to report. This is the piece that actually
        // delivers ONGOING custody — the property today's design checks only
        // when a process happens to restart. It also matters precisely because
        // this service is low-traffic: lazy validation alone might not
        // re-check a quiet tenant for a long time, and revocation is what you
        // want to notice quickly. See specs/cloudflare-migration.md § The boot
        // gate.
        //
        // Reports rather than throws, and runs BEFORE the sweep so a drift
        // report is not lost to a database problem.
        const drift = await revalidateAllPins({
            expectedPdsHost: APP_CONFIG.PDS_HOST,
            kv: bindings?.PIN_CACHE as PinCacheKV | undefined,
        });
        if (drift.length > 0) {
            logger.error(
                { drift },
                '[app-did] pin drift detected — a tenant DID no longer proves custody',
            );
        }

        // Mechanism 5: the reading `/health` can only report when someone
        // looks. The cutover incident lasted ~20 minutes because every surface
        // read green and nothing was watching — the lesson was written into the
        // spec and tracked by nothing, which is how it would have recurred.
        //
        // Hourly is the right cadence precisely because this state does not
        // flap: data does not appear and vanish between probes, so a check that
        // runs while nobody is awake is worth more than a faster one that only
        // runs when someone is already suspicious.
        const presence = await dataPresence({
            sql: servicesFor(bindings).sql,
            bucket: bindings?.BLOBS as R2ListLike | undefined,
        });
        if (isAudioBlackout(presence)) {
            // The incident, exactly: records resolve, post views carry embeds,
            // and every embed URL 404s. Downstream reads that as "the audio
            // failed" rather than as an outage, so this is the line that has to
            // exist for anyone to know otherwise.
            logger.error(
                { ...presence },
                '[data] audio blackout — records present but no blobs; every embed URL 404s',
            );
        } else if (presence.records === 'empty' && presence.blobs === 'empty') {
            // Both empty is a legitimately new deployment, so this is a warning
            // rather than an error. It is still logged: "nothing to serve" and
            // "serving fine" should never look identical in a log.
            logger.warn({ ...presence }, '[data] both stores are empty — nothing to serve');
        } else if (presence.records === 'unavailable' || presence.blobs === 'unavailable') {
            logger.error({ ...presence }, '[data] presence probe could not read a store');
        }

        const { sql, backend } = servicesFor(bindings);
        if (!sql) {
            // Firestore has native TTL, so there is nothing to sweep. Logged
            // rather than silent: on a Worker this means the database binding
            // is missing, which is a misconfiguration wearing a no-op's face.
            logger.warn({ backend }, '[sweep] no SQL backend bound — nothing to sweep');
            return;
        }
        await sweepExpired(sql, logger);
    },

    /**
     * The audio-processing consumer. One message is one post.
     *
     * ## Custody is proven inside the job, not here
     *
     * This handler mints `at://` uris — `AudioProcessingService.process`
     * reaches `getAppDid` through `buildPostUri` — and runs outside any
     * request, so no middleware has populated the snapshot for it. The check
     * therefore lives in `runProcessingJob`, after the payload is parsed and
     * the job's tenant is known, which is also where the HTTP re-drive route
     * needs it. Proving the whole registry here instead would fail this post
     * over a different tenant's DID.
     *
     * ## Why the batch is iterated sequentially
     *
     * `max_batch_size` is 1 (see `wrangler.jsonc` for the derivation), so this
     * loop sees one message in practice. It is still a loop, and still
     * sequential, because both properties have to hold if that setting is ever
     * raised: the batch shares one 15-minute invocation and one 128MB isolate,
     * and `readBlobBytes` materialises a whole blob. Running passes
     * concurrently would race several multi-megabyte buffers against that
     * isolate; running them in parallel batches of any size races the clock.
     *
     * ## Settled per message, not per batch
     *
     * A poisoned payload is `ack()`ed on its own rather than dragging its
     * batch-mates back through the queue with it. `retryAll()` is used only for
     * the pin gate, where the failure genuinely is batch-wide.
     */
    async queue(
        batch: MessageBatch<unknown>,
        env: unknown,
        _ctx: ExecutionContext,
    ): Promise<void> {
        for (const message of batch.messages) {
            const result = await runProcessingJob(
                message.body,
                env as Record<string, unknown> | undefined,
                { messageId: message.id, queue: batch.queue },
            );
            // The ack/retry decision is `lib/process-audio-job.ts`'s, shared
            // with the HTTP re-drive route so the two consumers cannot drift.
            if (shouldRetry(result)) message.retry();
            else message.ack();
        }
    },
} satisfies ExportedHandler;
