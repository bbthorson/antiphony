import type {
    ProcessingDispatchPort,
    ProcessingJob,
} from '@antiphony/core/ports/processing-dispatch';
import type { Logger } from '@antiphony/core/ports/logger';

/**
 * Cloudflare Queues dispatcher — the durable production adapter behind
 * `ProcessingDispatchPort` on Workers, replacing the Cloud Tasks one.
 *
 * It is the cheapest part of the migration, because
 * `ports/processing-dispatch.ts` was written for it: `dispatch()` is
 * `send(job)`, the job payload is two strings, and the consume side was never
 * a port. Compare the ~250 lines of `cloud-tasks.ts`, most of which is ADC
 * token handling, REST envelope construction, and config validation — all of
 * which a binding makes disappear.
 *
 * ## Three things that stop being problems
 *
 *   - **No credential.** Queues invoke the consumer by binding, so the shared
 *     `SYSTEM_AUTH_TOKEN` is not stored in each task's headers for its
 *     lifetime. `cloud-tasks.ts` documents that exposure at length as a real if
 *     bounded one; it simply does not exist here.
 *   - **No partial config to detect.** The Cloud Tasks adapter needs four env
 *     vars and an intent heuristic to tell "opted out" from "opted in and got
 *     it wrong". A binding is present or absent — there is no third state to
 *     diagnose.
 *   - **No worker URL.** The consumer is this same script, so there is no
 *     self-referential URL to configure and get wrong.
 *
 * ## No message id, so no dedup — deliberately
 *
 * Same reasoning as the Cloud Tasks adapter's missing task name. Recompute
 * re-dispatches the SAME post when a later PATCH changes its stages, and under
 * any id-based dedup that second, legitimate job is silently discarded as a
 * duplicate. Concurrency is the lease's job; it handles redelivery correctly
 * and does not confuse it with a real re-request.
 */

/**
 * The slice of Cloudflare's `Queue` this adapter uses.
 *
 * Declared structurally rather than by importing `@cloudflare/workers-types`,
 * for the same reason `adapters/outbound/r2/bucket.ts` gives — see that file.
 * The real binding satisfies it, so no cast is needed at the wiring site.
 */
export interface QueueLike<T> {
    send(message: T): Promise<void>;
}

export function queueDispatcher(
    queue: QueueLike<ProcessingJob>,
    logger: Logger,
): ProcessingDispatchPort {
    return {
        async dispatch(job: ProcessingJob): Promise<void> {
            // No timeout wrapper, unlike the Cloud Tasks enqueue. That one is
            // an authenticated HTTPS round trip to another cloud from inside
            // the create request, so a hung connection would hold the caller's
            // response open. This is a binding call inside the same runtime.
            //
            // It can still reject — the port's contract says so — and the
            // dispatch site catches, because the post is already committed by
            // the time we get here.
            await queue.send({ originAppId: job.originAppId, postId: job.postId });
            logger.info(
                { postId: job.postId, originAppId: job.originAppId },
                '[audio-processing] job enqueued',
            );
        },
    };
}

/**
 * This adapter as a `DurableDispatcherResolver` — the form
 * `lib/audio-processing.ts` installs.
 *
 * Reads the binding off the per-request `env` rather than closing over one,
 * because a Worker's bindings arrive on the invocation and do not exist at
 * module-evaluation time. Absent binding ⇒ `undefined` ⇒ the seam falls through
 * to the noop dispatcher, which logs that stages were left pending.
 *
 * That fall-through is quiet on purpose here, where the Cloud Tasks equivalent
 * is loud: a missing binding on Workers is caught before it can matter, because
 * `wrangler deploy` refuses a config naming a queue that does not exist. There
 * is no partially-configured state to warn about.
 */
export function queueResolver(logger: Logger) {
    return (env?: Record<string, unknown>): ProcessingDispatchPort | undefined => {
        const binding = env?.PROCESSING_QUEUE as QueueLike<ProcessingJob> | undefined;
        if (!binding || typeof binding.send !== 'function') return undefined;
        return queueDispatcher(binding, logger);
    };
}
