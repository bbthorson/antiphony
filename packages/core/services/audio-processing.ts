import type { AudioPostRecord } from 'shared/types/audio';
import {
    BYTE_MUTATING_STAGES,
    DERIVED_STAGES,
    PROCESSING_STAGES,
    type ProcessingStage,
    type ProcessingStageMap,
    type ProcessingState,
} from 'shared/types/processing';
import type { AudioProcessingDependencies } from '../ports/audio-processing-dependencies';
import type { TranscriberPort } from '../ports/transcription';
import type { DenoiserPort } from '../ports/audio-denoiser';
import type { TrimmerPort } from '../ports/audio-trimmer';
import type { WaveformPort } from '../ports/audio-waveform';
import { type Logger, defaultLogger } from '../ports/logger';
import { type ProcessingNotifierPort, noopNotifier } from '../ports/processing-notifier';
import { buildPostUri } from './audio-posts';

export interface ProcessingProviders {
    transcriber?: TranscriberPort;
    denoiser?: DenoiserPort;
    trimmer?: TrimmerPort;
    waveform?: WaveformPort;
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
        waveform: !!providers.waveform,
    };
}

/**
 * How long a runner's exclusive claim on a post lasts.
 *
 * Bounded from BELOW by the longest plausible pass — denoise is a network call
 * to ElevenLabs over a multi-megabyte upload, followed by two local ffmpeg
 * runs — because a lease that lapses under a live holder permits the very
 * overlap it exists to prevent. Bounded from ABOVE by how long a post stays
 * stuck after a runner dies without releasing, since nothing reclaims it
 * before expiry.
 *
 * 15 minutes sits well past any observed pass and inside Cloud Tasks' 30
 * minute maximum HTTP deadline, so the lease cannot outlive the delivery that
 * took it by more than the margin.
 *
 * **Exported so a dispatcher can bound its delivery by it.** The Cloud Tasks
 * adapter sets `dispatchDeadline` from this value, which is what keeps the two
 * numbers from drifting apart: a delivery allowed to run LONGER than the lease
 * is one that can outlive its own claim and race the runner that replaced it.
 * That coupling only holds if both read the same constant.
 */
export const PROCESSING_LEASE_MS = 15 * 60 * 1000;

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
 * run (Cloud Tasks redelivery) re-does nothing already settled. Denoise
 * output is content-addressed and the transcript is last-write-wins by
 * subject, so even a mid-stage retry converges.
 *
 * That covers SEQUENTIAL retry. Concurrent execution is a separate hazard —
 * two passes reading the same `pending` state both bill for it — and is closed
 * by the lease `process()` claims before doing anything; see
 * `PROCESSING_LEASE_MS` and `claimProcessingLease`.
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
        // Defaults to noop for the same reason `logger` defaults to console: a
        // deployment (or test) that wires no webhook keeps working unchanged,
        // and the outbound push is opt-in per tenant. See `settle`.
        private readonly notifier: ProcessingNotifierPort = noopNotifier,
    ) {
        this.capabilities = capabilitiesOf(providers);
    }

    /**
     * Persist a processing-state patch, then fire an outbound `StageSettledEvent`
     * for each stage the patch settled to a TERMINAL status (`ready`/`failed`/
     * `skipped`). Every terminal `patchProcessingState` in `runStages` goes
     * through here so the fire point is single and inherited by every dispatcher.
     *
     * **Write first, notify second.** The Firestore write is the authoritative
     * settle; the webhook is a latency accelerator over it. Ordering the write
     * first means a crash between them loses a NOTIFICATION, not a result — the
     * sweep/next-GET backstops the drop (see `specs/enrichment-webhooks.md`).
     *
     * **Notify never fails the pass.** Each `notify` is individually wrapped:
     * a rejection is logged and swallowed, so a webhook that times out or errors
     * never throws out of `process()`, never fails the stage, never holds the
     * lease. Delivery is best-effort by contract.
     *
     * **Only terminal stage keys fire.** A patch may also carry non-stage fields
     * (`processedBlobCid`, `waveformPeaks`, …) and the two `pending` recompute/
     * reapply writes; iterating `PROCESSING_STAGES` and gating on the terminal
     * values means those fire nothing, so routing every patch through here is
     * uniform and cannot mis-fire a `pending` transition as a settle.
     */
    private async settle(
        originAppId: string,
        postId: string,
        patch: Partial<Omit<ProcessingState, 'updatedAt'>>,
    ): Promise<void> {
        await this.deps.patchProcessingState(originAppId, postId, patch);
        const occurredAt = this.deps.now().toISOString();
        for (const stage of PROCESSING_STAGES) {
            const status = patch[stage];
            if (status !== 'ready' && status !== 'failed' && status !== 'skipped') continue;
            try {
                await this.notifier.notify({ originAppId, postId, stage, status, occurredAt });
            } catch (err) {
                this.logger.error(
                    { err, originAppId, postId, stage, status },
                    '[audio-processing] stage-settled webhook failed; swallowed (state already persisted)',
                );
            }
        }
    }

    /**
     * Run one post's outstanding processing, under an exclusive lease.
     *
     * The lease is claimed HERE rather than in the worker route so every
     * dispatcher inherits it — the hazard belongs to `process()`, not to a
     * transport. Losing the claim is a normal outcome, not an error: it means
     * another runner is already doing this work (or there is none to do), so
     * this returns cleanly and the caller must not retry. Retrying would only
     * spin against a held lease.
     *
     * Returns whether this call ACQUIRED the lease and ran the stages (`true`)
     * or found it already held / nothing to claim and did nothing (`false`).
     * Both are 200s to the queue — neither is retryable — but the two are not
     * the same event, and an at-least-once queue makes the declined case a
     * routine redelivery rather than an edge. The boolean is what lets the
     * worker log which one happened instead of reporting every delivery as work.
     */
    async process(originAppId: string, postId: string): Promise<boolean> {
        const leaseUntil = new Date(this.deps.now().getTime() + PROCESSING_LEASE_MS);
        if (!(await this.deps.claimProcessingLease(originAppId, postId, leaseUntil))) {
            this.logger.info(
                { originAppId, postId },
                '[audio-processing] lease not acquired; another runner holds it or there is nothing to process',
            );
            return false;
        }
        try {
            await this.runStages(originAppId, postId);
            return true;
        } finally {
            // Released even when a stage threw, so the post is immediately
            // reprocessable rather than parked for the rest of the TTL. The
            // stage's own state was already settled `failed` by the block that
            // threw; this only gives back the claim.
            //
            // Passing the claimed `leaseUntil` fences the release: if this
            // pass outlived its own lease and another runner took over, the
            // stored lease is no longer ours and the release does nothing
            // rather than clearing theirs.
            await this.deps.releaseProcessingLease(originAppId, postId, leaseUntil);
        }
    }

    private async runStages(originAppId: string, postId: string): Promise<void> {
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
        // Only links this deployment can actually RUN drive composition. A
        // pending link with no runner cannot rebuild anything, so letting it
        // set the restart point would reset the source to the original, settle
        // itself `skipped`, and re-run the later links over raw audio —
        // destroying a good variant and putting nothing in its place. It
        // settles `skipped` below without taking part.
        const firstPending = BYTE_MUTATING_STAGES.findIndex(
            (stage) => post.processing?.[stage] === 'pending' && this.capabilities[stage],
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
                      return (
                          (status === 'pending' || status === 'ready') && this.capabilities[stage]
                      );
                  });

        // A pending link with no runner settles `skipped`: accurate, because
        // nothing was ever produced for it. This is the one place that happens
        // now, so the stage blocks below can assume their provider exists.
        const unrunnable: ProcessingStageMap = {};
        for (const stage of BYTE_MUTATING_STAGES) {
            if (post.processing[stage] === 'pending' && !this.capabilities[stage]) {
                unrunnable[stage] = 'skipped';
            }
        }
        if (Object.keys(unrunnable).length > 0) {
            await this.settle(originAppId, postId, unrunnable);
        }

        // A `ready` link the chain would re-apply but cannot run is left alone,
        // never downgraded — the #42 rule, applied inside the chain. The
        // variant is missing that link and the state still says `ready`, so
        // like there, the log is the only record.
        const strandedChain = firstPending === -1
            ? []
            : BYTE_MUTATING_STAGES.slice(firstPending).filter(
                  (stage) => post.processing?.[stage] === 'ready' && !this.capabilities[stage],
              );
        if (strandedChain.length > 0) {
            this.logger.warn(
                { originAppId, postId, stages: strandedChain },
                '[audio-processing] chain re-ran without a runner for a ready link; variant is missing it',
            );
        }
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
            await this.settle(originAppId, postId, reapplied);
        }

        // --- Denoise (first, so transcription can use the cleaned audio) ---
        if (chainToRun.includes('denoise')) {
            // Non-null: `chainToRun` is filtered by capability, and `denoise`
            // capability IS the denoiser's presence. The no-runner case settled
            // `skipped` above.
            const denoiser = this.providers.denoiser!;
            if (!working) {
                await this.settle(originAppId, postId, { denoise: 'failed' });
            } else {
                try {
                    const cleaned = await denoiser.denoise({
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
                    await this.settle(originAppId, postId, {
                        denoise: 'ready',
                        processedBlobCid,
                        // Recorded because providers transcode: without it a
                        // later pass would read these bytes under the ORIGINAL
                        // embed's mime type.
                        processedMimeType: cleaned.mimeType,
                    });
                } catch {
                    await this.settle(originAppId, postId, { denoise: 'failed' });
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
            // Non-null for the same reason as the denoiser above.
            const trimmer = this.providers.trimmer!;
            if (!working) {
                await this.settle(originAppId, postId, { trim: 'failed' });
            } else {
                try {
                    const trimmed = await trimmer.trim({
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
                    await this.settle(originAppId, postId, {
                        trim: 'ready',
                        processedBlobCid,
                        processedMimeType: trimmed.mimeType,
                        // The first stage that makes the variant's duration
                        // genuinely differ from the record's immutable
                        // `embed.durationMs`. Step 7 reconciles the two.
                        processedDurationMs: trimmed.durationMs,
                    });
                } catch {
                    await this.settle(originAppId, postId, { trim: 'failed' });
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
            await this.settle(originAppId, postId, patch);
        }

        // --- Transcribe (uses the cleaned audio when denoise produced it) ---
        if (post.processing.transcribe === 'pending' || recompute.includes('transcribe')) {
            if (!this.providers.transcriber) {
                await this.settle(originAppId, postId, { transcribe: 'skipped' });
            } else if (!working) {
                await this.settle(originAppId, postId, { transcribe: 'failed' });
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
                    await this.settle(originAppId, postId, { transcribe: 'ready' });
                } catch {
                    await this.settle(originAppId, postId, { transcribe: 'failed' });
                }
            }
        }

        // --- Waveform (peaks over the same variant the transcript describes) ---
        //
        // Independent of transcribe: both are derived, neither reads the
        // other's artifact, so a transcriber failure above must not suppress
        // peaks. They are sequential here only because there is no reason to
        // add concurrency to a path that is about to move behind a queue.
        if (post.processing.waveform === 'pending' || recompute.includes('waveform')) {
            if (!this.providers.waveform) {
                await this.settle(originAppId, postId, { waveform: 'skipped' });
            } else if (!working) {
                await this.settle(originAppId, postId, { waveform: 'failed' });
            } else {
                try {
                    const result = await this.providers.waveform.waveform({
                        bytes: working.bytes,
                        mimeType: working.mimeType,
                    });
                    // Peaks and status in ONE patch. Split across two, a crash
                    // between them leaves `ready` over absent peaks — a state
                    // the view would read as "processed waveform available"
                    // and then find nothing, with no pending stage left to
                    // make a retry fix it.
                    await this.settle(originAppId, postId, {
                        waveform: 'ready',
                        waveformPeaks: result.peaks,
                    });
                } catch {
                    await this.settle(originAppId, postId, { waveform: 'failed' });
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
            await this.settle(originAppId, postId, patch);
        }
    }
}
