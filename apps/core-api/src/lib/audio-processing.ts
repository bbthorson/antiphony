import { AudioProcessingService, type ProcessingProviders } from '@antiphony/core/services/audio-processing';
import {
    PROCESSING_STAGES,
    type ProcessingRequest,
    type ProcessingStage,
    type ProcessingStageMap,
    type ResolvedProcessing,
} from 'shared/types/processing';
import { firebaseAudioProcessingDependencies } from '../adapters/outbound/firebase/audio-processing-dependencies.js';
import { stubTranscriber, stubDenoiser } from '../adapters/outbound/firebase/processing-providers.js';
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

/** Which stages this deployment can actually perform right now. */
export type ProcessingCapabilities = Record<ProcessingStage, boolean>;

function resolveProviders(): ProcessingProviders {
    if (process.env.ANTIPHONY_PROCESSING_STUB === 'true') {
        return { transcriber: stubTranscriber, denoiser: stubDenoiser };
    }
    // Real ElevenLabs providers slot in here in steps 2-3.
    return {};
}

/**
 * Which stages this deployment can actually perform right now. `trim` and
 * `waveform` have no port yet (steps 5-6), so they are always false — a
 * request for them resolves to `skipped`, never a stage that hangs `pending`.
 */
export function processingCapabilities(): ProcessingCapabilities {
    const p = resolveProviders();
    return {
        transcribe: !!p.transcriber,
        denoise: !!p.denoiser,
        trim: false,
        waveform: false,
    };
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
