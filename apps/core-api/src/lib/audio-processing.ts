import {
    AudioProcessingService,
    capabilitiesOf,
    type ProcessingCapabilities,
    type ProcessingProviders,
} from '@antiphony/core/services/audio-processing';
import {
    PROCESSING_STAGES,
    type ProcessingRequest,
    type ProcessingStage,
    type ProcessingStageMap,
    type ResolvedProcessing,
} from 'shared/types/processing';
import { firebaseAudioProcessingDependencies } from '../adapters/outbound/firebase/audio-processing-dependencies.js';
import { stubTranscriber, stubDenoiser, stubTrimmer } from '../adapters/outbound/firebase/processing-providers.js';
import { elevenLabsApiKey } from '../adapters/outbound/elevenlabs/client.js';
import { elevenLabsTranscriber } from '../adapters/outbound/elevenlabs/transcriber.js';
import { elevenLabsDenoiser } from '../adapters/outbound/elevenlabs/denoiser.js';
import { ffmpegTrimmer, ffmpegAvailable } from '../adapters/outbound/ffmpeg/trimmer.js';
import { logger } from './logger.js';

/**
 * Composition + dispatch seam for audio processing (B5).
 *
 * Resolved per-request off env (like `getOriginAppId`) so tests and per-env
 * config take effect without a module-load singleton:
 *   - `ANTIPHONY_PROCESSING_STUB=true`   → wire the stub providers (dev/tests).
 *   - `ANTIPHONY_PROCESSING_INLINE=true` → run processing synchronously inside
 *     the create request. This is the local/test trigger; the durable
 *     production trigger (Cloud Tasks → a `/system/process-audio` worker) is a
 *     later sub-PR. With neither flag set, processing is unavailable and
 *     requested stages settle as `skipped`.
 */

/**
 * Which stages this deployment can actually perform right now. Defined in core
 * alongside `capabilitiesOf`; re-exported here so existing importers of this
 * module are unaffected.
 */
export type { ProcessingCapabilities };

function resolveProviders(): ProcessingProviders {
    // Stub wins when explicitly set, so a dev/test env with a real key lying
    // around in the shell cannot accidentally bill a live provider.
    if (process.env.ANTIPHONY_PROCESSING_STUB === 'true') {
        return { transcriber: stubTranscriber, denoiser: stubDenoiser, trimmer: stubTrimmer };
    }
    // Trim is LOCAL compute — no API key, so it is available on its binary
    // alone. This is the first stage that can change the variant with no
    // provider key configured anywhere, which is exactly the condition the
    // recompute filter in `AudioProcessingService` had to be corrected for.
    const trimmer = ffmpegAvailable() ? ffmpegTrimmer : undefined;

    // Real providers select off the API key alone — no separate enable flag to
    // keep in sync with it. Key present ⇒ the stage is available.
    if (elevenLabsApiKey()) {
        return { transcriber: elevenLabsTranscriber, denoiser: elevenLabsDenoiser, trimmer };
    }
    return { trimmer };
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
 * Dispatch processing for a freshly-created post. In inline mode, runs the
 * service synchronously (awaited). Errors are swallowed with a log — a
 * processing failure must never fail the create response (the stage state
 * records the failure). The durable Cloud Tasks trigger replaces the inline
 * branch in a later sub-PR.
 */
export async function dispatchProcessing(originAppId: string, postId: string): Promise<void> {
    if (process.env.ANTIPHONY_PROCESSING_INLINE !== 'true') return;
    try {
        const service = new AudioProcessingService(firebaseAudioProcessingDependencies, resolveProviders());
        await service.process(originAppId, postId);
    } catch (err) {
        logger.error({ err, postId }, '[audio-processing] inline dispatch failed');
    }
}
