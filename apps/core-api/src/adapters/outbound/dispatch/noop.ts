import type {
    ProcessingDispatchPort,
    ProcessingJob,
} from '@antiphony/core/ports/processing-dispatch';
import type { Logger } from '@antiphony/core/ports/logger';

/**
 * Noop dispatcher — the deployment has no way to run processing, so the job is
 * dropped with a log.
 *
 * This is not a failure path. `resolveInitialProcessing` settles a stage as
 * `skipped` when the deployment can't perform it, so a post reaching here at
 * all means at least one stage resolved to `pending` — the deployment can run
 * the stage but has nowhere to run it. That combination is a misconfiguration
 * (providers wired, dispatch not), and it is worth a log line rather than
 * silence, because the visible symptom is a post that sits `pending` forever
 * with nothing in the record explaining why.
 *
 * Deliberately does NOT settle those stages as `failed`. `pending` is the
 * truthful state — the work has not been attempted and is not doomed; wiring a
 * dispatcher makes the same post processable on its next trigger. Marking it
 * failed would bake a transient config gap into per-post state.
 */
export function noopDispatcher(logger: Logger): ProcessingDispatchPort {
    return {
        async dispatch(job: ProcessingJob): Promise<void> {
            logger.warn(
                { postId: job.postId, originAppId: job.originAppId },
                '[audio-processing] no dispatcher configured — stages left pending',
            );
        },
    };
}
