import {
    capabilitiesOf,
    type ProcessingCapabilities,
    type ProcessingProviders,
} from '@antiphony/core/services/audio-processing';
import type { ProcessingDispatchPort } from '@antiphony/core/ports/processing-dispatch';
import type { ProcessingNotifierPort } from '@antiphony/core/ports/processing-notifier';
import {
    PROCESSING_STAGES,
    type ProcessingRequest,
    type ProcessingStage,
    type ProcessingStageMap,
    type ResolvedProcessing,
} from 'shared/types/processing';
import { firebaseAudioProcessingDependencies } from '../adapters/outbound/firebase/audio-processing-dependencies.js';
import {
    stubTranscriber,
    stubDenoiser,
    stubTrimmer,
    stubWaveform,
} from '../adapters/outbound/firebase/processing-providers.js';
import { elevenLabsApiKey } from '../adapters/outbound/elevenlabs/client.js';
import { elevenLabsTranscriber } from '../adapters/outbound/elevenlabs/transcriber.js';
import { elevenLabsDenoiser } from '../adapters/outbound/elevenlabs/denoiser.js';
import { ffmpegTrimmer } from '../adapters/outbound/ffmpeg/trimmer.js';
import { ffmpegWaveform } from '../adapters/outbound/ffmpeg/waveform.js';
import { ffmpegAvailable } from '../adapters/outbound/ffmpeg/run.js';
import { inlineDispatcher } from '../adapters/outbound/dispatch/inline.js';
import { webhookNotifier } from '../adapters/outbound/webhook/notifier.js';
import { noopDispatcher } from '../adapters/outbound/dispatch/noop.js';
import {
    cloudTasksConfig,
    cloudTasksDispatcher,
    cloudTasksRequested,
} from '../adapters/outbound/dispatch/cloud-tasks.js';
import { logger } from './logger.js';

/**
 * Composition + dispatch seam for audio processing (B5).
 *
 * Resolved per-request off env (like `getOriginAppId`) so tests and per-env
 * config take effect without a module-load singleton:
 *   - `ANTIPHONY_PROCESSING_STUB=true`   → wire the stub providers (dev/tests).
 *   - `ANTIPHONY_PROCESSING_INLINE=true` → wire the inline dispatcher, which
 *     runs processing synchronously inside the request. This is the local/test
 *     trigger.
 *   - Otherwise, if the `ANTIPHONY_TASKS_*` vars are set → the Cloud Tasks
 *     dispatcher, which enqueues against this deployment's own
 *     `/api/v1/system/process-audio` worker. This is production.
 *   - With neither → the noop dispatcher logs and drops.
 *
 * Note the two flags govern DIFFERENT axes and neither implies the other:
 * `_STUB` decides which providers can do the work, `_INLINE` decides who runs
 * it. A deployment with real providers and no dispatcher has capable stages
 * and nowhere to run them — that is the case the noop dispatcher logs.
 */

/**
 * Which stages this deployment can actually perform right now. Defined in core
 * alongside `capabilitiesOf`; re-exported here so existing importers of this
 * module are unaffected.
 */
export type { ProcessingCapabilities };

/**
 * Exported for the queue worker route, which builds its own
 * `AudioProcessingService` outside any request that resolved providers already.
 * Still called per invocation rather than memoized — see the module docstring.
 */
export function resolveProviders(): ProcessingProviders {
    // Stub wins when explicitly set, so a dev/test env with a real key lying
    // around in the shell cannot accidentally bill a live provider.
    if (process.env.ANTIPHONY_PROCESSING_STUB === 'true') {
        return {
            transcriber: stubTranscriber,
            denoiser: stubDenoiser,
            trimmer: stubTrimmer,
            waveform: stubWaveform,
        };
    }
    // Trim and waveform are LOCAL compute — no API key, so they are available
    // on their binary alone, and one probe governs both. Trim is the stage that
    // can change the variant with no provider key configured anywhere, which is
    // exactly the condition the recompute filter in `AudioProcessingService`
    // had to be corrected for; waveform is the derived stage that condition was
    // corrected FOR, and with ffmpeg present both are runnable together, so the
    // stranded-artifact path needs a deployment missing the binary to reach.
    const local = ffmpegAvailable()
        ? { trimmer: ffmpegTrimmer, waveform: ffmpegWaveform }
        : {};

    // Real providers select off the API key alone — no separate enable flag to
    // keep in sync with it. Key present ⇒ the stage is available.
    if (elevenLabsApiKey()) {
        return { transcriber: elevenLabsTranscriber, denoiser: elevenLabsDenoiser, ...local };
    }
    return local;
}

/**
 * Which stages this deployment can actually perform right now.
 *
 * Delegates to `capabilitiesOf` rather than mapping providers to stages again:
 * `AudioProcessingService` filters its recompute set through the same function,
 * and a second copy here would let the two disagree — a stage advertised as
 * runnable but never recomputed serves a permanently stale artifact under a
 * `ready` status.
 */
export function processingCapabilities(): ProcessingCapabilities {
    return capabilitiesOf(resolveProviders());
}

/**
 * Resolve an app's opt-in request into the initial per-stage state to store:
 * `pending` when the deployment can do it, `skipped` when it can't. Returns
 * undefined when nothing was requested.
 */
export function resolveInitialProcessing(
    request: ProcessingRequest | undefined,
): ResolvedProcessing | undefined {
    if (!request || !PROCESSING_STAGES.some((stage) => request[stage])) return undefined;
    const caps = processingCapabilities();
    const state: ResolvedProcessing = {};
    for (const stage of PROCESSING_STAGES) {
        if (request[stage]) state[stage] = caps[stage] ? 'pending' : 'skipped';
    }
    // Always written, including the default. `setProcessing` MERGES onto the
    // stored state, so omitting it would let an earlier request's `false`
    // silently govern a later request that never asked to opt out. Absent
    // remains true for posts written before this field existed.
    state.reprocess = request.reprocess !== false;
    return state;
}

/** True when at least one stage still needs work (i.e. dispatch is worthwhile). */
export function hasPendingStage(state: ProcessingStageMap | undefined): boolean {
    return !!state && PROCESSING_STAGES.some((stage) => state[stage] === 'pending');
}

/**
 * The outbound stage-settled notifier for this deployment. Always the webhook
 * adapter: it resolves each tenant's `{url, secret}` per event and no-ops for a
 * tenant with none configured, so a deployment with no webhooks wired needs no
 * separate branch here — absence is handled tenant-by-tenant inside the adapter.
 *
 * Resolved per-invocation (like `resolveProviders`) so env-driven config takes
 * effect in tests and across restarts without a module-load singleton. The
 * worker route builds its own `AudioProcessingService` and calls this directly.
 */
export function resolveNotifier(): ProcessingNotifierPort {
    return webhookNotifier(logger);
}

/**
 * Which dispatcher this deployment runs jobs through. Resolved per-request off
 * env, like `resolveProviders`, so a test can set the flag without a
 * module-load singleton fixing the choice at import time.
 */
function resolveDispatcher(): ProcessingDispatchPort {
    // Inline wins, so a developer with queue config in their shell cannot
    // accidentally enqueue against a real Cloud Tasks queue from a local run —
    // the same precedence, and the same reasoning, as `_STUB` over real
    // providers.
    if (process.env.ANTIPHONY_PROCESSING_INLINE === 'true') {
        return inlineDispatcher(
            firebaseAudioProcessingDependencies,
            resolveProviders(),
            logger,
            resolveNotifier(),
        );
    }

    const resolved = cloudTasksConfig();
    if (resolved.config) return cloudTasksDispatcher(resolved.config, logger);

    // Partial config is a MISCONFIGURATION, not an opt-out, and the two must
    // not degrade to the same silent noop. A deployment that set some of the
    // queue vars believes it has durable dispatch and has none; every post sits
    // `pending` forever with nothing saying why.
    //
    // Keyed on INTENT rather than on how many values are missing. Counting
    // cannot work here: `GOOGLE_CLOUD_PROJECT` is set by the platform and
    // `SYSTEM_AUTH_TOKEN` by every other `/system/*` route, so a deployment
    // that cleanly opted out still reports only three missing and would trip
    // any threshold — firing this error at every correctly-configured
    // noop deployment, which is how a real misconfiguration gets tuned out.
    if (cloudTasksRequested()) {
        logger.error(
            { missing: resolved.missing },
            '[audio-processing] Cloud Tasks dispatch is partially configured — falling back to noop, jobs will be dropped',
        );
    }
    return noopDispatcher(logger);
}

/**
 * Dispatch processing for a post whose state has already been persisted.
 *
 * **Never throws.** The post is committed by the time this is called and the
 * response has to succeed regardless: a create that 500s because a queue was
 * briefly unreachable would leave the caller retrying a write that already
 * landed. The failure is logged and the stages stay `pending`.
 *
 * Leaving them `pending` is deliberate. It is the truthful state — the work
 * was not attempted — and it stays recoverable, where marking them `failed`
 * would record a permanent verdict about a transient outage. The cost is that
 * nothing currently re-drives a post whose dispatch failed; closing that needs
 * a reconciliation sweep over `pending` posts, which is its own piece of work
 * and is not part of this seam.
 */
export async function dispatchProcessing(originAppId: string, postId: string): Promise<void> {
    try {
        await resolveDispatcher().dispatch({ originAppId, postId });
    } catch (err) {
        logger.error({ err, postId, originAppId }, '[audio-processing] dispatch failed');
    }
}
