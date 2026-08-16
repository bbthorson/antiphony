import { z } from 'zod';
import { AudioProcessingService } from '@antiphony/core/services/audio-processing';
import { servicesFor } from '../composition.js';
import { resolveProviders, resolveNotifier } from './audio-processing.js';
import { ensureTenantPin, type PinCacheKV } from './app-did.js';
import { APP_CONFIG } from './app-config.js';
import { logger } from './logger.js';

/**
 * Run one processing job, and classify the result for whatever delivered it.
 *
 * ## Why this is shared rather than inlined in each consumer
 *
 * There are two consume sides and there will keep being two. Cloudflare Queues
 * invokes `queue(batch, env)` and is the production path; `POST /api/v1/system/
 * process-audio` stays as the manual re-drive, which costs nothing and is the
 * thing you want at 3am. Both are thin wrappers around the same
 * `AudioProcessingService.process(originAppId, postId)` call, and both have to
 * make the same judgement about redelivery from the same outcome.
 *
 * They express that judgement in different vocabularies — an HTTP status code
 * versus `ack()`/`retry()` — which is exactly the kind of difference that lets
 * two copies of one decision drift apart silently. So the decision is made
 * once, here, and each consumer only translates it.
 *
 * ## The classification, and why it is worth this much care
 *
 * Retry semantics here are not a description of what happened — they are an
 * instruction about whether to do the work again. Getting it backwards is
 * expensive in a specific way: denoise and transcribe both BILL on the attempt,
 * not on the success, so a wrongly-retried job costs real money every time.
 *
 * The split follows one question — *is there anything a retry could change?*
 *
 *   - **`ran`** — the pass executed. Includes stages that settled `failed`: a
 *     failed stage is already recorded in the post's own state and `process()`
 *     acts only on `pending`, so a redelivery would re-read that state and do
 *     nothing. The retry cannot help and the attempt already cost money.
 *   - **`ran: false`** — the lease was declined, or there was nothing to do.
 *     Another runner holds the post, which is a normal outcome on an
 *     at-least-once queue. A retry would only spin against it. `process()` does
 *     not distinguish its three declined cases and should not: the delivery
 *     decision is identical for all of them. The boolean exists so the outcome
 *     is not ambiguous in the logs.
 *   - **`invalid`** — a malformed payload is not transient. Retrying replays
 *     the same bad bytes on the same schedule until the queue gives up.
 *   - **`threw`** — the ONLY retryable case. An error escaping `process()` came
 *     from outside a stage's own try/catch — database unreachable, storage down
 *     — which means infrastructure, not this post. Nothing was recorded, so a
 *     retry is both safe and the only thing that recovers it. The lease was
 *     already released in `process()`'s `finally`, so the redelivery can claim
 *     it immediately rather than waiting out the TTL.
 */

const ProcessAudioJobSchema = z.object({
    originAppId: z.string().min(1),
    postId: z.string().min(1),
});

export type ProcessingJobOutcome =
    | { outcome: 'ran'; ran: boolean }
    | { outcome: 'invalid' }
    | { outcome: 'threw'; err: unknown };

/**
 * Whether the delivering system should hand this job back.
 * See § The classification for why only one outcome qualifies.
 *
 * A type predicate rather than a plain boolean so each consumer's non-retry
 * branch narrows to the outcomes it actually has to render — the route reads
 * `result.ran` there, and it should not need a cast to do so.
 */
export function shouldRetry(
    result: ProcessingJobOutcome,
): result is Extract<ProcessingJobOutcome, { outcome: 'threw' }> {
    return result.outcome === 'threw';
}

/**
 * @param raw     — the job payload, already decoded from its transport.
 * @param env     — the runtime bindings, for the composition root. A Worker's
 *                  `env`; `undefined` under Node.
 * @param context — extra log fields identifying the delivery (a request id, a
 *                  queue message id). Purely for correlation.
 */
export async function runProcessingJob(
    raw: unknown,
    env: Record<string, unknown> | undefined,
    context: Record<string, unknown> = {},
): Promise<ProcessingJobOutcome> {
    const parsed = ProcessAudioJobSchema.safeParse(raw);
    if (!parsed.success) {
        logger.error(
            { ...context, issues: parsed.error.issues },
            '[audio-processing] worker: invalid job payload',
        );
        return { outcome: 'invalid' };
    }

    const { originAppId, postId } = parsed.data;

    // Prove custody before doing any work. A processing pass mints `at://` uris
    // — `AudioProcessingService.process` reaches `getAppDid` through
    // `buildPostUri` — and both consume paths run outside any request, so no
    // auth middleware has populated the snapshot for this tenant. Under Node
    // the boot gate already did, and this is a map lookup.
    //
    // Failure is classified as `threw`, i.e. RETRYABLE, including for a
    // positive disproof that a retry cannot fix. That is deliberate: three
    // attempts and then the dead letter queue puts the job somewhere visible,
    // where acking it would silently drop a post's processing over a
    // configuration error. Losing work is the worse failure.
    try {
        await ensureTenantPin(originAppId, {
            expectedPdsHost: APP_CONFIG.PDS_HOST,
            kv: env?.PIN_CACHE as PinCacheKV | undefined,
        });
    } catch (err) {
        logger.error(
            { ...context, err, postId, originAppId },
            '[audio-processing] worker: app-DID custody unproven; asking for redelivery',
        );
        return { outcome: 'threw', err };
    }

    // Built per job, not per module, for the same reason `resolveProviders` is
    // read per request: a module-load singleton would freeze the provider set
    // at import time and make env-driven config in tests inert.
    //
    // Providers resolve for the JOB's tenant, not the caller's. The caller is
    // the queue, so the tenancy is the one named in the payload — wiring
    // anything else here would run one tenant's post through another tenant's
    // pinned provider.
    const service = new AudioProcessingService(
        servicesFor(env).audioProcessingDeps,
        resolveProviders(originAppId),
        logger,
        resolveNotifier(),
    );

    try {
        const ran = await service.process(originAppId, postId);
        return { outcome: 'ran', ran };
    } catch (err) {
        logger.error(
            { ...context, err, postId, originAppId },
            '[audio-processing] worker: pass threw; asking for redelivery',
        );
        return { outcome: 'threw', err };
    }
}
