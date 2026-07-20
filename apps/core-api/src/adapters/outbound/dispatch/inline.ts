import { AudioProcessingService } from '@antiphony/core/services/audio-processing';
import type {
    ProcessingDispatchPort,
    ProcessingJob,
} from '@antiphony/core/ports/processing-dispatch';
import type { ProcessingProviders } from '@antiphony/core/services/audio-processing';
import type { AudioProcessingDependencies } from '@antiphony/core/ports/audio-processing-dependencies';
import type { Logger } from '@antiphony/core/ports/logger';
import type { ProcessingNotifierPort } from '@antiphony/core/ports/processing-notifier';

/**
 * Inline dispatcher — runs processing synchronously inside the calling
 * request, awaited.
 *
 * **Dev and test only** (`ANTIPHONY_PROCESSING_INLINE=true`). It makes the
 * whole create → process → hydrate loop observable in one HTTP round-trip,
 * which is what the route tests assert against and what makes local iteration
 * bearable. In production it would hold a request open for the length of an
 * ElevenLabs call plus two ffmpeg runs, and lose the work entirely if the
 * instance were recycled mid-flight — hence durable dispatch.
 *
 * Being an ADAPTER rather than a branch inside the dispatch seam is the point:
 * every environment now goes through the same `dispatch()` call, so the tests
 * exercise the production code path and differ only in which implementation is
 * wired behind it.
 *
 * Errors propagate. The port's contract is that a dispatcher does not swallow
 * its own failures, and the dispatch site catches — same handling the durable
 * adapter will get, rather than a second policy that only inline mode uses.
 * Note this makes an inline dispatch's rejection mean "the processing run
 * threw", where a queued dispatch's means "the enqueue failed": the two are
 * not the same event, and only the inline one implies the work was attempted.
 *
 * `logger` is REQUIRED, not optional. `AudioProcessingService` defaults to
 * `defaultLogger`, which is `console` — and its two warnings are the
 * stranded-artifact paths, where the log line is the ONLY record that a post
 * is serving an artifact describing audio that no longer exists. Under console
 * those arrive as Node inspect output rather than pino's JSON, so in Cloud
 * Logging they land as an unparsed string with no severity and no requestId,
 * which is precisely when they are least findable. Making the parameter
 * required means omitting it is a compile error rather than a silent
 * downgrade — the mistake this file already shipped once.
 */
export function inlineDispatcher(
    deps: AudioProcessingDependencies,
    providers: ProcessingProviders,
    logger: Logger,
    notifier: ProcessingNotifierPort,
): ProcessingDispatchPort {
    return {
        async dispatch(job: ProcessingJob): Promise<void> {
            const service = new AudioProcessingService(deps, providers, logger, notifier);
            await service.process(job.originAppId, job.postId);
        },
    };
}
