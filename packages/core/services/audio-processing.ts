import type { AudioPostRecord } from 'shared/types/audio';
import { PROCESSING_STAGES, type ProcessingStageMap } from 'shared/types/processing';
import type { AudioProcessingDependencies } from '../ports/audio-processing-dependencies';
import type { TranscriberPort } from '../ports/transcription';
import type { DenoiserPort } from '../ports/audio-denoiser';
import { buildPostUri } from './audio-posts';

export interface ProcessingProviders {
    transcriber?: TranscriberPort;
    denoiser?: DenoiserPort;
}

/**
 * AudioProcessingService — runs one post's opted-in audio processing (B5).
 *
 * Order matters: **denoise first, then transcribe**, so the transcript is
 * produced from the cleaned audio when denoise was requested. Each stage
 * settles the post's `processing` state (`ready`/`failed`/`skipped`) as it
 * finishes, so progress is observable on the read view.
 *
 * Idempotent: only acts on stages currently marked `pending`, so a retried
 * run (Cloud Tasks redelivery, later) re-does nothing already settled. Denoise
 * output is content-addressed and the transcript is last-write-wins by
 * subject, so even a mid-stage retry converges.
 *
 * The service performs NO external I/O itself — transcription and denoise are
 * `TranscriberPort`/`DenoiserPort`, and all storage is `AudioProcessingDependencies`.
 */
export class AudioProcessingService {
    constructor(
        private readonly deps: AudioProcessingDependencies,
        private readonly providers: ProcessingProviders,
    ) {}

    async process(originAppId: string, postId: string): Promise<void> {
        const post = await this.deps.getPostById(originAppId, postId);
        // Nothing to do: post gone/cross-tenant, or no processing was requested.
        if (!post || !post.processing) return;

        const audioCid = post.embed?.audio?.ref?.$link;
        // A post with processing requested but no audio: settle every pending
        // stage as skipped (there's nothing to process).
        if (!audioCid) {
            await this.settlePendingAsSkipped(originAppId, postId, post);
            return;
        }

        // Source audio to work from. If a byte-mutating stage already completed
        // on a prior run (idempotent retry with transcribe still pending),
        // start from the processed variant — otherwise transcription would
        // fall back to the noisy original.
        const sourceCid = post.processing.processedBlobCid ?? audioCid;
        const sourceBytes = await this.deps.readBlobBytes(originAppId, sourceCid);
        const sourceMime = post.embed?.audio?.mimeType ?? 'application/octet-stream';
        // Audio the transcriber reads — reassigned to the cleaned variant if
        // denoise runs in THIS pass, so transcription always uses the best audio.
        let working: { bytes: Uint8Array; mimeType: string } | null = sourceBytes
            ? { bytes: sourceBytes, mimeType: sourceMime }
            : null;

        // --- Denoise (first, so transcription can use the cleaned audio) ---
        if (post.processing.denoise === 'pending') {
            if (!this.providers.denoiser) {
                await this.deps.patchProcessingState(originAppId, postId, { denoise: 'skipped' });
            } else if (!working) {
                await this.deps.patchProcessingState(originAppId, postId, { denoise: 'failed' });
            } else {
                try {
                    const cleaned = await this.providers.denoiser.denoise({
                        bytes: working.bytes,
                        mimeType: working.mimeType,
                    });
                    const processedBlobCid = await this.deps.writeDerivedBlob(
                        originAppId,
                        cleaned.bytes,
                        cleaned.mimeType,
                    );
                    working = { bytes: cleaned.bytes, mimeType: cleaned.mimeType };
                    await this.deps.patchProcessingState(originAppId, postId, {
                        denoise: 'ready',
                        processedBlobCid,
                    });
                } catch {
                    await this.deps.patchProcessingState(originAppId, postId, { denoise: 'failed' });
                }
            }
        }

        // --- Transcribe (uses the cleaned audio when denoise produced it) ---
        if (post.processing.transcribe === 'pending') {
            if (!this.providers.transcriber) {
                await this.deps.patchProcessingState(originAppId, postId, { transcribe: 'skipped' });
            } else if (!working) {
                await this.deps.patchProcessingState(originAppId, postId, { transcribe: 'failed' });
            } else {
                try {
                    const result = await this.providers.transcriber.transcribe({
                        bytes: working.bytes,
                        mimeType: working.mimeType,
                        durationMs: post.embed?.durationMs,
                        langHint: post.langs?.[0],
                    });
                    await this.deps.saveTranscript({
                        id: this.deps.newTranscriptId(),
                        subject: { uri: buildPostUri(this.deps.getAppDid(originAppId), post.id), cid: post.cid },
                        transcript: result.transcript,
                        lang: result.lang,
                        model: result.model,
                        createdAt: this.deps.now(),
                    });
                    await this.deps.patchProcessingState(originAppId, postId, { transcribe: 'ready' });
                } catch {
                    await this.deps.patchProcessingState(originAppId, postId, { transcribe: 'failed' });
                }
            }
        }
    }

    /** Settle any still-pending stage as skipped (used when the post has no audio). */
    private async settlePendingAsSkipped(
        originAppId: string,
        postId: string,
        post: AudioPostRecord,
    ): Promise<void> {
        const state = post.processing;
        if (!state) return;
        // Every stage, not just the implemented ones — a stage this deployment
        // cannot run must still settle rather than sit `pending` forever.
        const patch: ProcessingStageMap = {};
        for (const stage of PROCESSING_STAGES) {
            if (state[stage] === 'pending') patch[stage] = 'skipped';
        }
        if (Object.keys(patch).length > 0) {
            await this.deps.patchProcessingState(originAppId, postId, patch);
        }
    }
}
