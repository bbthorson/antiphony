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
import type { TrimmerPort } from '../ports/audio-trimmer';
import { type Logger, defaultLogger } from '../ports/logger';
import { buildPostUri } from './audio-posts';

export interface ProcessingProviders {
    transcriber?: TranscriberPort;
    denoiser?: DenoiserPort;
    trimmer?: TrimmerPort;
}

/** Which stages a deployment can actually perform, given its wired providers. */
export type ProcessingCapabilities = Record<ProcessingStage, boolean>;

/**
 * The single mapping from wired providers to runnable stages. Both the
 * deployment's advertised capabilities and this service's recompute filter
 * derive from here — two copies drift, and a copy that says a stage is
 * runnable when the recompute filter says it is not yields a stage that runs
 * on request but is never refreshed when its variant changes.
 *
 * The `Record<ProcessingStage, …>` return type is the guard: adding a stage to
 * `PROCESSING_STAGES` makes this literal a compile error until it is handled.
 */
export function capabilitiesOf(providers: ProcessingProviders): ProcessingCapabilities {
    return {
        transcribe: !!providers.transcriber,
        denoise: !!providers.denoiser,
        trim: !!providers.trimmer,
        // Port arrives in step 6. Until then a request settles `skipped`
        // rather than hanging `pending`.
        waveform: false,
    };
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
    /** Derived once from the wired providers; see `capabilitiesOf`. */
    private readonly capabilities: ProcessingCapabilities;

    constructor(
        private readonly deps: AudioProcessingDependencies,
        private readonly providers: ProcessingProviders,
        private readonly logger: Logger = defaultLogger,
    ) {
        this.capabilities = capabilitiesOf(providers);
    }

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

        // Byte-mutating stages form an ORDERED CHAIN (denoise → trim) that
        // composes into one variant, so re-running any link decides both where
        // to read from and which other links must re-run.
        //
        // Find the earliest link that is pending. Everything from there on has
        // to run: an earlier stage re-running changes the input to every later
        // one, so a later stage sitting `ready` describes audio that no longer
        // exists — the same argument as derived recompute below, applied within
        // the chain instead of after it.
        const firstPending = BYTE_MUTATING_STAGES.findIndex(
            (stage) => post.processing?.[stage] === 'pending',
        );

        // Re-running the chain's FIRST link rebuilds from the original: its own
        // prior output is what the variant holds, and denoising already
        // denoised audio compounds artifacts and bills a second time. Re-running
        // a LATER link starts from the variant, which already holds every
        // earlier link's output — reading the original there would silently
        // discard them (a trim-only re-run would drop the denoise).
        //
        // No link pending at all is the idempotent-retry case (denoise settled
        // last pass, transcribe still pending); it must not fall back to the
        // noisy original either.
        const sourceCid = firstPending !== 0 && post.processing.processedBlobCid
            ? post.processing.processedBlobCid
            : audioCid;

        // Ready links after the first pending one are re-applied, not skipped.
        // Only `pending` (requested) and `ready` (previously applied, and whose
        // input just changed) qualify — a `skipped` or `failed` link stays that
        // way rather than being silently activated by a neighbour's re-run.
        const chainToRun: ProcessingStage[] =
            firstPending === -1
                ? []
                : BYTE_MUTATING_STAGES.slice(firstPending).filter((stage) => {
                      const status = post.processing?.[stage];
                      return status === 'pending' || status === 'ready';
                  });
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

        // A `ready` link being re-applied is marked `pending` BEFORE it runs,
        // for the same reason derived recompute is: if this pass dies partway,
        // a retry must find outstanding work. Left `ready`, it would compute
        // `firstPending === -1` on the retry and re-run nothing, stranding a
        // variant that is missing that link forever.
        const reapplied: ProcessingStageMap = {};
        for (const stage of chainToRun) {
            if (post.processing[stage] === 'ready') reapplied[stage] = 'pending';
        }
        if (Object.keys(reapplied).length > 0) {
            await this.deps.patchProcessingState(originAppId, postId, reapplied);
        }

        // --- Denoise (first, so transcription can use the cleaned audio) ---
        if (chainToRun.includes('denoise')) {
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

        // --- Trim (after denoise: silence detection needs the noise floor gone) ---
        //
        // Composes into the SAME processedBlobCid rather than adding a second
        // variant: `working` already holds the denoised bytes when denoise ran
        // in this pass, so trimming them chains the two byte-mutating stages
        // into one artifact.
        if (chainToRun.includes('trim')) {
            if (!this.providers.trimmer) {
                await this.deps.patchProcessingState(originAppId, postId, { trim: 'skipped' });
            } else if (!working) {
                await this.deps.patchProcessingState(originAppId, postId, { trim: 'failed' });
            } else {
                try {
                    const trimmed = await this.providers.trimmer.trim({
                        bytes: working.bytes,
                        mimeType: working.mimeType,
                    });
                    const processedBlobCid = await this.deps.writeDerivedBlob(
                        originAppId,
                        trimmed.bytes,
                        trimmed.mimeType,
                    );
                    working = { bytes: trimmed.bytes, mimeType: trimmed.mimeType };
                    variantChanged = true;
                    await this.deps.patchProcessingState(originAppId, postId, {
                        trim: 'ready',
                        processedBlobCid,
                        processedMimeType: trimmed.mimeType,
                        // The first stage that makes the variant's duration
                        // genuinely differ from the record's immutable
                        // `embed.durationMs`. Step 7 reconciles the two.
                        processedDurationMs: trimmed.durationMs,
                    });
                } catch {
                    await this.deps.patchProcessingState(originAppId, postId, { trim: 'failed' });
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
        // `post.processing?.` rather than `post.processing.`: the line-48 guard
        // narrows in the method body, but TS discards that narrowing inside a
        // callback, since the property is mutable and the callback could run
        // later. Same reason as the `.some()` above. Removing it does not
        // compile.
        const superseded =
            variantChanged && post.processing.reprocess !== false
                ? DERIVED_STAGES.filter((stage) => post.processing?.[stage] === 'ready')
                : [];

        // A stage this deployment cannot run is excluded rather than marked
        // pending. Marking it would settle it `skipped` below, downgrading a
        // `ready` stage to "never attempted" while its now-stale artifact stays
        // readable — the state would be strictly less true than leaving it
        // alone. Same end state as `reprocess: false`, reached for a different
        // reason. Reachable as soon as a byte-mutating stage runs locally
        // (trim, step 5), since that sets `variantChanged` with no API key and
        // so no transcriber.
        const recompute = superseded.filter((stage) => this.hasRunnerFor(stage));

        // Logged because the state cannot record it: the stage stays `ready`
        // over an artifact that no longer matches the audio, and nothing
        // distinguishes it from a fresh one. Recompute only re-fires when the
        // variant changes again, so restoring the provider does not repair
        // these on its own — this line is the only way to enumerate them.
        const stranded = superseded.filter((stage) => !this.hasRunnerFor(stage));
        if (stranded.length > 0) {
            this.logger.warn(
                { originAppId, postId, stages: stranded },
                '[audio-processing] variant changed but no runner; leaving stale artifact ready',
            );
        }

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
     * Whether this deployment can actually run a derived stage. Only consulted
     * for the recompute set: an explicitly requested stage with no runner still
     * settles `skipped`, which is accurate there — nothing was ever produced.
     *
     * Narrowed to derived stages because that is the only call site; a
     * byte-mutating stage passed here would be a compile error rather than a
     * silently unreachable branch.
     */
    private hasRunnerFor(stage: (typeof DERIVED_STAGES)[number]): boolean {
        return this.capabilities[stage];
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
