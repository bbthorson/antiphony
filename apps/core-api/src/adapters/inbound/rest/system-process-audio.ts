import { Hono } from 'hono';
import { requireSystemAuth } from '../../../middleware/system-auth.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { runProcessingJob, shouldRetry } from '../../../lib/process-audio-job.js';
import { logger } from '../../../lib/logger.js';

/**
 * Manual re-drive route, mounted at `/api/v1/system/process-audio`.
 *
 *   POST / — run one post's outstanding audio processing.
 *
 * This was the Cloud Tasks worker route, and on Workers it is no longer the
 * production consume path — Cloudflare Queues invokes `queue(batch, env)` in
 * `worker.ts` instead. It stays because it costs nothing and is the thing you
 * want at 3am: a way to push one post through the pipeline by hand, with no
 * queue in the loop, from anything that can hold a bearer token.
 *
 * It is deliberately NOT a port: the enqueue side is portable, the consume side
 * is platform-shaped, and both are thin wrappers around the same
 * `AudioProcessingService.process(originAppId, postId)` call. See
 * `ports/processing-dispatch.ts`.
 *
 * **System-auth'd, like every other `/system/*` route.** An unauthenticated
 * worker would let anyone on the internet drive billable ElevenLabs calls
 * against any post id they can guess.
 *
 * **Not in the OpenAPI document.** Every `/system/*` route stays plain-Hono
 * rather than `@hono/zod-openapi` (see `app.ts`), and this one has no reason to
 * differ: its only callers are our own queue and our own operators.
 *
 * ## Status codes are retry instructions
 *
 * Cloud Tasks retries on non-2xx and stops on 2xx, so the status code here is a
 * decision about whether to do the work again rather than a description of what
 * happened. That decision now lives in `lib/process-audio-job.ts` — shared with
 * the queue consumer, which makes the same call in `ack()`/`retry()` terms —
 * and this handler only translates it:
 *
 *   - **200** — the pass ran, or was declined, or the payload was junk. Nothing
 *     a retry could change. `ran` disambiguates the first two in the logs.
 *   - **503** — the pass threw, i.e. infrastructure rather than this post.
 *     Deliberately not rethrown into the global error handler: that would
 *     render a 500, which a queue also retries, but as an unhandled fault
 *     rather than a deliberate "come back".
 */

const app = new Hono();

app.post('/', requireSystemAuth(), async (c) => {
    let raw: unknown;
    try {
        raw = await c.req.json();
    } catch {
        // 200: unparseable bytes do not become parseable on the third delivery.
        // Handled here rather than in `runProcessingJob` because decoding the
        // transport is the transport's business — a queue message arrives
        // already decoded.
        logger.error(
            { requestId: c.get('requestId') },
            '[audio-processing] worker: invalid JSON body',
        );
        return c.json({ success: true, data: { ran: false, reason: 'invalid-body' } });
    }

    const result = await runProcessingJob(raw, c.env as Record<string, unknown> | undefined, {
        requestId: c.get('requestId'),
    });

    if (shouldRetry(result)) {
        return c.json(errorEnvelope(c, 'Processing failed; retry'), 503);
    }
    if (result.outcome === 'invalid') {
        return c.json({ success: true, data: { ran: false, reason: 'invalid-payload' } });
    }
    return c.json({ success: true, data: { ran: result.ran } });
});

export { app as systemProcessAudioRoute };
