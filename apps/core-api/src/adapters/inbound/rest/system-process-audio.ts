import { Hono } from 'hono';
import { z } from 'zod';
import { AudioProcessingService } from '@antiphony/core/services/audio-processing';
import { requireSystemAuth } from '../../../middleware/system-auth.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { firebaseAudioProcessingDependencies } from '../../outbound/firebase/audio-processing-dependencies.js';
import { resolveProviders } from '../../../lib/audio-processing.js';
import { logger } from '../../../lib/logger.js';

/**
 * Queue worker route, mounted at `/api/v1/system/process-audio`.
 *
 *   POST / — run one post's outstanding audio processing.
 *
 * This is the consume side of the dispatch seam. It is deliberately NOT a port:
 * the enqueue side is portable, the consume side is platform-shaped (Cloud
 * Tasks pushes HTTP here; Cloudflare Queues would invoke a `queue()` handler
 * over a batch), and both are thin wrappers around the same
 * `AudioProcessingService.process(originAppId, postId)` call. See
 * `ports/processing-dispatch.ts`.
 *
 * **System-auth'd, like every other `/system/*` route.** Cloud Tasks presents
 * the shared `SYSTEM_AUTH_TOKEN` bearer that the enqueuing adapter baked into
 * the task. An unauthenticated worker would let anyone on the internet drive
 * billable ElevenLabs calls against any post id they can guess.
 *
 * **Not in the OpenAPI document.** Every `/system/*` route stays plain-Hono
 * rather than `@hono/zod-openapi` (see `app.ts`), and this one has no reason to
 * differ: its only caller is our own queue. That settles the plan's "contract →
 * patch if the system route is documented; none if internal" as **no bump**.
 *
 * ## Status codes are retry instructions
 *
 * Cloud Tasks retries on non-2xx and stops on 2xx, so the status code here is
 * not a description of what happened — it is a decision about whether to do the
 * work again. Getting it backwards is expensive in a specific way: a stage that
 * already failed and was recorded as `failed` would be retried, and denoise and
 * transcribe both BILL on the attempt, not on the success.
 *
 * The split follows a single question — *is there anything a retry could
 * change?*
 *
 *   - **200, work ran.** Including when stages settled `failed`. A failed stage
 *     is already recorded in the post's own state and `process()` acts only on
 *     `pending`, so a redelivery would re-read that state and do nothing. The
 *     retry cannot help and the attempt already cost money.
 *   - **200, lease declined.** Another runner holds the post, or there was
 *     nothing to do. Both are normal outcomes, and both are things a retry would
 *     only spin against — so the STATUS is identical to a run. The body differs:
 *     `process()` returns `false`, which surfaces as `ran: false` so the 200 is
 *     not ambiguous in the logs. `process()` does not distinguish its three
 *     declined cases from each other, which is right — the queue's decision is
 *     the same for all of them.
 *   - **200, bad payload.** A malformed body is not transient; retrying it
 *     replays the same bad bytes on the same schedule until the queue gives up.
 *     Logged at `error` and swallowed, because the queue has no better move.
 *   - **503, the pass threw.** This is the only retryable case: an error
 *     escaping `process()` came from OUTSIDE a stage's own try/catch — Firestore
 *     unreachable, storage down — which means infrastructure, not this post.
 *     Nothing was recorded, so a retry is both safe and the only thing that
 *     recovers it. The lease was already released in `process()`'s `finally`,
 *     so the redelivery can claim it immediately rather than waiting out the
 *     TTL.
 */

const ProcessAudioJobSchema = z.object({
    originAppId: z.string().min(1),
    postId: z.string().min(1),
});

const app = new Hono();

app.post('/', requireSystemAuth(), async (c) => {
    let raw: unknown;
    try {
        raw = await c.req.json();
    } catch {
        // 200: see § Status codes. Unparseable bytes do not become parseable on
        // the third delivery.
        logger.error({ requestId: c.get('requestId') }, '[audio-processing] worker: invalid JSON body');
        return c.json({ success: true, data: { ran: false, reason: 'invalid-body' } });
    }

    const parsed = ProcessAudioJobSchema.safeParse(raw);
    if (!parsed.success) {
        logger.error(
            { requestId: c.get('requestId'), issues: parsed.error.issues },
            '[audio-processing] worker: invalid job payload',
        );
        return c.json({ success: true, data: { ran: false, reason: 'invalid-payload' } });
    }

    const { originAppId, postId } = parsed.data;

    // Built per request, not per module, for the same reason `resolveProviders`
    // is read per request: a module-load singleton would freeze the provider
    // set at import time and make env-driven config in tests inert.
    const service = new AudioProcessingService(
        firebaseAudioProcessingDependencies,
        resolveProviders(),
        logger,
    );

    try {
        // `ran` is false when the lease was already held (or there was nothing
        // to claim) — a routine redelivery on an at-least-once queue, not work.
        // Both are 200s; the boolean is what keeps the 200 from being ambiguous
        // in the logs. See § Status codes.
        const ran = await service.process(originAppId, postId);
        return c.json({ success: true, data: { ran } });
    } catch (err) {
        // The one retryable case. Deliberately NOT rethrown into the global
        // error handler: that would render a 500, which Cloud Tasks also
        // retries, but it would do so as an unhandled fault rather than a
        // deliberate "come back". 503 says the same thing to the queue and
        // reads correctly in the logs.
        logger.error(
            { err, postId, originAppId, requestId: c.get('requestId') },
            '[audio-processing] worker: pass threw; asking the queue to retry',
        );
        return c.json(errorEnvelope(c, 'Processing failed; retry'), 503);
    }
});

export { app as systemProcessAudioRoute };
