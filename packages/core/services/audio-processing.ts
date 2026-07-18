import type { AudioPostRecord } from 'shared/types/audio';
import {
    BYTE_MUTATING_STAGES,
    DERIVED_STAGES,
    PROCESSING_STAGES,
    type ProcessingStage,
    type ProcessingStageMap,
} from 'shared/types/processing';
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
 * When a byte-mutating stage completes, any derived artifact that already
 * exists now describes superseded audio, so it is marked `pending` again and
 * recomputed in the same pass (`reprocess: false` opts out).
 *
 * Idempotent: acts on stages marked `pending` plus that recompute set, so a retried
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

        // Source audio to work from.
        //
        // If a byte-mutating stage is pending, it is about to (re)run, and the
        // variant it would read is its OWN prior output — denoising already
        // denoised audio compounds artifacts and bills a second time. Byte-
        // mutating stages compose from the original, so a re-run restarts
        // there and rebuilds the variant.
        //
        // Otherwise start from the processed variant when one exists: the
        // idempotent-retry case (denoise settled last pass, transcribe still
        // pending) must not fall back to the noisy original.
        const rerunningByteMutating = BYTE_MUTATING_STAGES.some(
            (stage) => post.processing?.[stage] === 'pending',
        );
        const sourceCid = !rerunningByteMutating && post.processing.processedBlobCid
            ? post.processing.processedBlobCid
            : audioCid;
        const sourceBytes = await this.deps.readBlobBytes(originAppId, sourceCid);
        // The mime type must describe the bytes actually read. A provider may
        // transcode (ElevenLabs Voice Isolator returns MP3 whatever it is
        // given), so the variant's type is recorded on the state rather than
        // assumed to match the original embed.
        const originalMime = post.embed?.audio?.mimeType ?? 'application/octet-stream';
        const sourceMime = sourceCid === post.processing.processedBlobCid
            ? post.processing.processedMimeType ?? originalMime
            : originalMime;
        // Audio the transcriber reads — reassigned to the cleaned variant if
        // denoise runs in THIS pass, so transcription always uses the best audio.
        let working: { bytes: Uint8Array; mimeType: string } | null = sourceBytes
            ? { bytes: sourceBytes, mimeType: sourceMime }
            : null;

        // Set when a byte-mutating stage produces a NEW variant in this pass,
        // which is what invalidates the derived artifacts below.
        let variantChanged = false;

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
                    variantChanged = true;
                    await this.deps.patchProcessingState(originAppId, postId, {
                        denoise: 'ready',
                        processedBlobCid,
                        // Recorded because providers transcode: without it a
                        // later pass would read these bytes under the ORIGINAL
                        // embed's mime type.
                        processedMimeType: cleaned.mimeType,
                    });
                } catch {
                    await this.deps.patchProcessingState(originAppId, postId, { denoise: 'failed' });
                }
            }
        }

        // --- Auto-recompute of derived artifacts ---
        //
        // A completed byte-mutating stage supersedes the audio every derived
        // artifact describes: the transcript is of sound that is no longer
        // served. Derived stages are pure functions of the variant, so
        // recomputing is always the correct response to it changing.
        //
        // This cannot cascade. The recompute set is drawn from DERIVED_STAGES,
        // and no byte-mutating stage reads a derived artifact, so a recompute
        // can never mark byte-mutating work pending and retrigger this branch.
        //
        // `reprocess: false` opts out, leaving the stale artifact and its
        // `ready` status in place — the app's explicit choice not to re-bill.
        //
        // A stage this deployment cannot run is excluded rather than marked
        // pending. Marking it would settle it `skipped` below, downgrading a
        // `ready` stage to "never attempted" while its now-stale artifact stays
        // readable — the state would be strictly less true than leaving it
        // alone. Same end state as `reprocess: false`, reached for a different
        // reason. Reachable as soon as a byte-mutating stage runs locally
        // (trim, step 5), since that sets `variantChanged` with no API key and
        // so no transcriber.
        const recompute =
            variantChanged && post.processing.reprocess !== false
                ? DERIVED_STAGES.filter(
                      (stage) => post.processing?.[stage] === 'ready' && this.hasRunnerFor(stage),
                  )
                : [];

        if (recompute.length > 0) {
            const patch: ProcessingStageMap = {};
            for (const stage of recompute) patch[stage] = 'pending';
            // Written BEFORE the re-run, not after. If this pass dies here, a
            // retry must find outstanding work rather than a `ready` transcript
            // of audio that no longer exists.
            await this.deps.patchProcessingState(originAppId, postId, patch);
        }

        // --- Transcribe (uses the cleaned audio when denoise produced it) ---
        if (post.processing.transcribe === 'pending' || recompute.includes('transcribe')) {
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

    /**
     * Whether this deployment can actually run a stage. Only consulted for the
     * recompute set: an explicitly requested stage with no runner still settles
     * `skipped`, which is accurate there — nothing was ever produced.
     */
    private hasRunnerFor(stage: ProcessingStage): boolean {
        switch (stage) {
            case 'transcribe':
                return !!this.providers.transcriber;
            case 'denoise':
                return !!this.providers.denoiser;
            // Ports arrive in steps 5-6; no runner exists yet.
            case 'trim':
            case 'waveform':
                return false;
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
