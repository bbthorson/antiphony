import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioProcessingService, type ProcessingProviders } from './audio-processing';
import { buildPostUri } from './audio-posts';
import type { AudioProcessingDependencies } from '../ports/audio-processing-dependencies';
import type { AudioPostRecord, TranscriptEnrichmentRecord } from 'shared/types/audio';
import { BYTE_MUTATING_STAGES, type ProcessingState } from 'shared/types/processing';

const AUDIO_CID = 'bafkreioriginal';
const CLEANED_CID = 'bafkreicleaned';

/** Deterministic per-tenant app DID for the fake — stands in for the boot-validated pin. */
const appDidFor = (originAppId: string) => `did:web:${originAppId}.example`;

function makePost(over: Partial<AudioPostRecord> = {}): AudioPostRecord {
    return {
        id: 'p1',
        cid: 'bafyreipost',
        originAppId: 'vox-pop',
        authorId: 'u1',
        kind: 'prompt',
        text: 'hi',
        embed: {
            $type: 'dev.antiphony.embed.audio',
            audio: { $type: 'blob', ref: { $link: AUDIO_CID }, mimeType: 'audio/webm', size: 2048 },
            durationMs: 4200,
        },
        createdAt: new Date('2026-07-03T00:00:00Z'),
        ...over,
    } as AudioPostRecord;
}

/** In-memory deps that records processing-state patches and captures the saved transcript. */
function makeDeps(post: AudioPostRecord | null, over: Partial<AudioProcessingDependencies> = {}) {
    const patches: Array<Partial<Omit<ProcessingState, 'updatedAt'>>> = [];
    const saved: TranscriptEnrichmentRecord[] = [];
    let derivedCounter = 0;
    const deps: AudioProcessingDependencies = {
        getPostById: vi.fn(async () => post),
        getAppDid: vi.fn((originAppId: string) => appDidFor(originAppId)),
        readBlobBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
        writeDerivedBlob: vi.fn(async () => (derivedCounter++ === 0 ? CLEANED_CID : `bafkrei${derivedCounter}`)),
        saveTranscript: vi.fn(async (r: TranscriptEnrichmentRecord) => { saved.push(r); }),
        patchProcessingState: vi.fn(async (_app, _id, patch) => { patches.push(patch); }),
        // Uncontended by default, so every existing case exercises the work
        // rather than the declined-claim path. The lease's own behaviour is
        // covered by the `over` overrides in its describe block.
        claimProcessingLease: vi.fn(async () => true),
        releaseProcessingLease: vi.fn(async () => undefined),
        newTranscriptId: vi.fn(() => 't1'),
        now: vi.fn(() => new Date('2026-07-03T00:00:00Z')),
        ...over,
    };
    return { deps, patches, saved };
}

const stubTranscript = {
    transcript: { segments: [{ startMs: 0, endMs: 4200, text: 'hello' }], text: 'hello' },
    lang: 'en',
    model: 'stub-1',
};

function providers(over: Partial<ProcessingProviders> = {}): ProcessingProviders {
    return {
        transcriber: { transcribe: vi.fn(async () => stubTranscript) },
        denoiser: { denoise: vi.fn(async () => ({ bytes: new Uint8Array([9, 9]), mimeType: 'audio/webm' })) },
        // Re-encodes to mp3 and shortens, mirroring the real adapter: the
        // trimmer is where the 320kbps inflation is undone, so a result whose
        // mimeType matched its input would not exercise the interesting path.
        trimmer: {
            trim: vi.fn(async () => ({
                bytes: new Uint8Array([7]),
                mimeType: 'audio/mpeg',
                durationMs: 3100,
            })),
        },
        waveform: { waveform: vi.fn(async () => ({ peaks: [0, 50, 100] })) },
        ...over,
    };
}

describe('AudioProcessingService.process', () => {
    let p: ProcessingProviders;
    beforeEach(() => { p = providers(); });

    it('is a no-op when no processing was requested', async () => {
        const { deps, patches, saved } = makeDeps(makePost({ processing: undefined }));
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');
        expect(patches).toEqual([]);
        expect(saved).toEqual([]);
        expect(p.transcriber!.transcribe).not.toHaveBeenCalled();
    });

    it('is a no-op when the post is gone', async () => {
        const { deps, patches } = makeDeps(null);
        await new AudioProcessingService(deps, p).process('vox-pop', 'gone');
        expect(patches).toEqual([]);
    });

    it('transcribes and writes an enrichment with the post StrongRef as subject', async () => {
        const post = makePost({ processing: { transcribe: 'pending', updatedAt: new Date() } });
        const { deps, patches, saved } = makeDeps(post);
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

        expect(saved).toHaveLength(1);
        expect(saved[0].subject).toEqual({ uri: buildPostUri(appDidFor(post.originAppId), post.id), cid: post.cid });
        expect(saved[0].transcript.text).toBe('hello');
        expect(saved[0].model).toBe('stub-1');
        expect(patches).toContainEqual({ transcribe: 'ready' });
    });

    it('denoises: writes a derived blob and records its CID', async () => {
        const post = makePost({ processing: { denoise: 'pending', updatedAt: new Date() } });
        const { deps, patches } = makeDeps(post);
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

        expect(deps.writeDerivedBlob).toHaveBeenCalledTimes(1);
        expect(patches).toContainEqual(
            expect.objectContaining({ denoise: 'ready', processedBlobCid: CLEANED_CID }),
        );
    });

    it('runs denoise before transcribe, and transcribes the CLEANED audio', async () => {
        const post = makePost({ processing: { transcribe: 'pending', denoise: 'pending', updatedAt: new Date() } });
        const { deps } = makeDeps(post);
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

        // Transcriber received the denoiser's output bytes ([9,9]), not the original ([1,2,3]).
        const call = vi.mocked(p.transcriber!.transcribe).mock.calls[0][0];
        expect(Array.from(call.bytes)).toEqual([9, 9]);
    });

    it('transcribes the cleaned audio when denoise already completed on a prior run', async () => {
        // Idempotent retry: denoise settled last time, transcribe still pending.
        const post = makePost({
            processing: { transcribe: 'pending', denoise: 'ready', processedBlobCid: CLEANED_CID, updatedAt: new Date() },
        });
        const { deps, patches, saved } = makeDeps(post, {
            readBlobBytes: vi.fn(async (_app, cid) =>
                cid === CLEANED_CID ? new Uint8Array([9, 9]) : new Uint8Array([1, 2, 3]),
            ),
        });
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

        // Denoise is NOT re-run (already ready); transcription reads the cleaned bytes.
        expect(deps.writeDerivedBlob).not.toHaveBeenCalled();
        expect(saved).toHaveLength(1);
        const call = vi.mocked(p.transcriber!.transcribe).mock.calls[0][0];
        expect(Array.from(call.bytes)).toEqual([9, 9]);
        expect(patches).toContainEqual({ transcribe: 'ready' });
    });

    it('re-denoises from the ORIGINAL audio, not the existing variant', async () => {
        // Regression: a re-requested denoise (stage back to `pending` while a
        // variant from the prior run persists) must not feed already-denoised
        // audio back through the denoiser — that compounds artifacts and bills
        // a second time. Byte-mutating stages compose from the original.
        const post = makePost({
            processing: { denoise: 'pending', processedBlobCid: CLEANED_CID, updatedAt: new Date() },
        });
        const { deps } = makeDeps(post, {
            readBlobBytes: vi.fn(async (_app, cid) =>
                cid === CLEANED_CID ? new Uint8Array([9, 9]) : new Uint8Array([1, 2, 3]),
            ),
        });
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

        expect(deps.readBlobBytes).toHaveBeenCalledWith('vox-pop', AUDIO_CID);
        const call = vi.mocked(p.denoiser!.denoise).mock.calls[0]![0];
        expect(Array.from(call.bytes)).toEqual([1, 2, 3]);
    });

    it('records the variant mime type, and reads the variant back under it', async () => {
        // Providers transcode (Voice Isolator returns MP3 whatever it is
        // given), so a later pass reading the variant must not label it with
        // the original embed's type.
        const post = makePost({ processing: { denoise: 'pending', updatedAt: new Date() } });
        const transcoding = providers({
            denoiser: { denoise: vi.fn(async () => ({ bytes: new Uint8Array([9, 9]), mimeType: 'audio/mpeg' })) },
        });
        const { deps, patches } = makeDeps(post);
        await new AudioProcessingService(deps, transcoding).process('vox-pop', 'p1');

        expect(patches).toContainEqual(
            expect.objectContaining({ denoise: 'ready', processedMimeType: 'audio/mpeg' }),
        );
    });

    it('transcribes the variant under the variant mime type', async () => {
        const post = makePost({
            processing: {
                transcribe: 'pending',
                denoise: 'ready',
                processedBlobCid: CLEANED_CID,
                processedMimeType: 'audio/mpeg',
                updatedAt: new Date(),
            },
        });
        const { deps } = makeDeps(post, {
            readBlobBytes: vi.fn(async () => new Uint8Array([9, 9])),
        });
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

        // NOT the original embed's audio/webm.
        const call = vi.mocked(p.transcriber!.transcribe).mock.calls[0]![0];
        expect(call.mimeType).toBe('audio/mpeg');
    });

    it('marks a requested stage skipped when its provider is absent', async () => {
        const post = makePost({ processing: { transcribe: 'pending', denoise: 'pending', updatedAt: new Date() } });
        const { deps, patches, saved } = makeDeps(post);
        await new AudioProcessingService(deps, {}).process('vox-pop', 'p1');
        expect(patches).toContainEqual({ transcribe: 'skipped' });
        expect(patches).toContainEqual({ denoise: 'skipped' });
        expect(saved).toEqual([]);
    });

    it('settles every pending stage as skipped when the post has no audio', async () => {
        // Includes the not-yet-implemented stages: a stage with no runner must
        // still settle rather than sit `pending` forever and look like work in
        // flight to a polling client.
        const post = makePost({
            embed: undefined,
            processing: {
                transcribe: 'pending',
                denoise: 'pending',
                trim: 'pending',
                waveform: 'pending',
                updatedAt: new Date(),
            },
        });
        const { deps, patches } = makeDeps(post);
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

        expect(patches).toContainEqual({
            transcribe: 'skipped',
            denoise: 'skipped',
            trim: 'skipped',
            waveform: 'skipped',
        });
    });

    it('leaves already-settled stages alone when the post has no audio', async () => {
        const post = makePost({
            embed: undefined,
            processing: { transcribe: 'pending', denoise: 'ready', updatedAt: new Date() },
        });
        const { deps, patches } = makeDeps(post);
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

        // Only the pending stage is touched — `denoise: 'ready'` is not clobbered.
        expect(patches).toEqual([{ transcribe: 'skipped' }]);
    });

    it('marks a stage failed when its provider throws, without blocking the other stage', async () => {
        const post = makePost({ processing: { transcribe: 'pending', denoise: 'pending', updatedAt: new Date() } });
        const failingDenoise = providers({
            denoiser: { denoise: vi.fn(async () => { throw new Error('provider down'); }) },
        });
        const { deps, patches, saved } = makeDeps(post);
        await new AudioProcessingService(deps, failingDenoise).process('vox-pop', 'p1');

        expect(patches).toContainEqual({ denoise: 'failed' });
        // Transcription still ran (on the original audio, since denoise failed).
        expect(saved).toHaveLength(1);
        const call = vi.mocked(failingDenoise.transcriber!.transcribe).mock.calls[0][0];
        expect(Array.from(call.bytes)).toEqual([1, 2, 3]);
        expect(patches).toContainEqual({ transcribe: 'ready' });
    });

    it('skips pending stages when the post has no audio', async () => {
        const post = makePost({ embed: undefined, processing: { transcribe: 'pending', updatedAt: new Date() } });
        const { deps, patches, saved } = makeDeps(post);
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');
        expect(patches).toEqual([{ transcribe: 'skipped' }]);
        expect(saved).toEqual([]);
    });

    it('is idempotent: does not re-run an already-settled stage', async () => {
        const post = makePost({ processing: { transcribe: 'ready', denoise: 'failed', updatedAt: new Date() } });
        const { deps, patches, saved } = makeDeps(post);
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');
        expect(patches).toEqual([]);
        expect(saved).toEqual([]);
        expect(p.transcriber!.transcribe).not.toHaveBeenCalled();
    });

    it('fails a stage when the audio bytes cannot be read', async () => {
        const post = makePost({ processing: { transcribe: 'pending', updatedAt: new Date() } });
        const { deps, patches } = makeDeps(post, { readBlobBytes: vi.fn(async () => null) });
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');
        expect(patches).toContainEqual({ transcribe: 'failed' });
    });

    describe('trim', () => {
        it('settles the variant with its duration and re-encoded type', async () => {
            const { deps, patches } = makeDeps(makePost({
                processing: { trim: 'pending', updatedAt: new Date() },
            }));
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(patches).toContainEqual({
                trim: 'ready',
                processedBlobCid: CLEANED_CID,
                processedMimeType: 'audio/mpeg',
                processedDurationMs: 3100,
            });
        });

        it('trims the DENOISED bytes, composing both stages into one variant', async () => {
            // The property that makes denoise+trim one artifact rather than
            // two: trim reads `working`, which denoise reassigned in this pass.
            const { deps, patches } = makeDeps(makePost({
                processing: { denoise: 'pending', trim: 'pending', updatedAt: new Date() },
            }));
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(Array.from(vi.mocked(p.trimmer!.trim).mock.calls[0][0].bytes)).toEqual([9, 9]);
            // Two writes, but the LAST settle is the composed variant — the
            // trimmed bytes, not the denoiser's intermediate output.
            const settled = patches.filter((patch) => patch.processedBlobCid).at(-1);
            expect(settled?.processedMimeType).toBe('audio/mpeg');
            expect(settled?.processedDurationMs).toBe(3100);
        });

        it('runs after denoise, never before', async () => {
            // Ordering is load-bearing: silence detection needs the noise floor
            // gone, so trimming first would find nothing to trim.
            const { deps, patches } = makeDeps(makePost({
                processing: { denoise: 'pending', trim: 'pending', updatedAt: new Date() },
            }));
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(patches.findIndex((patch) => patch.denoise === 'ready')).toBeLessThan(
                patches.findIndex((patch) => patch.trim === 'ready'),
            );
        });

        it('trims the denoised variant when denoise settled in an EARLIER pass', async () => {
            // The composition bug step 5 introduces: `trim: 'pending'` makes
            // `rerunningByteMutating` true, which resets the source to the
            // ORIGINAL. Denoise is already `ready` so it does not re-run, and
            // trim would silently operate on the noisy original — discarding
            // the denoised audio while the state still claims denoise `ready`.
            const { deps } = makeDeps(
                makePost({
                    processing: {
                        denoise: 'ready',
                        trim: 'pending',
                        processedBlobCid: CLEANED_CID,
                        processedMimeType: 'audio/webm',
                        updatedAt: new Date(),
                    },
                }),
                {
                    readBlobBytes: vi.fn(async (_app: string, cid: string) =>
                        cid === CLEANED_CID ? new Uint8Array([9, 9]) : new Uint8Array([1, 2, 3]),
                    ),
                },
            );
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(Array.from(vi.mocked(p.trimmer!.trim).mock.calls[0][0].bytes)).toEqual([9, 9]);
        });

        it('re-applies a ready trim when denoise re-runs ahead of it', async () => {
            // The mirror of the case above. Denoise re-running rebuilds the
            // variant from the original, so a trim sitting `ready` describes
            // audio that no longer exists — leaving it alone would serve an
            // untrimmed variant while the state claims trim `ready`.
            const { deps, patches } = makeDeps(makePost({
                processing: {
                    denoise: 'pending',
                    trim: 'ready',
                    processedBlobCid: CLEANED_CID,
                    updatedAt: new Date(),
                },
            }));
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(p.trimmer!.trim).toHaveBeenCalledTimes(1);
            // Marked pending before re-running, so a pass that dies partway
            // leaves outstanding work rather than a `ready` link that is gone.
            expect(patches.some((patch) => patch.trim === 'pending')).toBe(true);
            expect(patches.findIndex((patch) => patch.trim === 'pending')).toBeLessThan(
                patches.findIndex((patch) => patch.trim === 'ready'),
            );
        });

        it('does not activate a skipped link when a neighbour re-runs', async () => {
            // `skipped` means the deployment cannot do it; a neighbour's re-run
            // is not a reason to start.
            const { deps, patches } = makeDeps(makePost({
                processing: { denoise: 'pending', trim: 'skipped', updatedAt: new Date() },
            }));
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(p.trimmer!.trim).not.toHaveBeenCalled();
            expect(patches.some((patch) => patch.trim === 'pending')).toBe(false);
        });

        it('keeps the variant when a pending link has no runner', async () => {
            // Denoise re-requested after the key went away, with a trim already
            // applied. Letting the unrunnable denoise set the restart point
            // would rebuild from the original and re-trim raw audio, destroying
            // the denoised variant and putting nothing in its place.
            const noDenoiser = providers({ denoiser: undefined });
            const { deps, patches } = makeDeps(makePost({
                processing: {
                    denoise: 'pending',
                    trim: 'ready',
                    processedBlobCid: CLEANED_CID,
                    updatedAt: new Date(),
                },
            }));
            await new AudioProcessingService(deps, noDenoiser).process('vox-pop', 'p1');

            expect(patches).toContainEqual({ denoise: 'skipped' });
            // The variant is untouched: nothing re-ran, nothing was written.
            expect(deps.writeDerivedBlob).not.toHaveBeenCalled();
            expect(p.trimmer!.trim).not.toHaveBeenCalled();
            expect(patches.some((patch) => patch.processedBlobCid)).toBe(false);
        });

        it('never downgrades a ready link the chain cannot re-run', async () => {
            // #42's rule, inside the chain: denoise re-runs, but trim is ready
            // with no trimmer. Marking it would settle it `skipped` — "never
            // attempted" — for work that was in fact done.
            const noTrimmer = providers({ trimmer: undefined });
            const { deps, patches } = makeDeps(makePost({
                processing: {
                    denoise: 'pending',
                    trim: 'ready',
                    processedBlobCid: CLEANED_CID,
                    updatedAt: new Date(),
                },
            }));
            await new AudioProcessingService(deps, noTrimmer).process('vox-pop', 'p1');

            expect(patches.some((patch) => patch.trim === 'skipped')).toBe(false);
            expect(patches.some((patch) => patch.trim === 'pending')).toBe(false);
            // Denoise still ran — it has a runner.
            expect(deps.writeDerivedBlob).toHaveBeenCalledTimes(1);
        });

        it('marks trim skipped when no trimmer is wired', async () => {
            const { deps, patches } = makeDeps(makePost({
                processing: { trim: 'pending', updatedAt: new Date() },
            }));
            await new AudioProcessingService(deps, providers({ trimmer: undefined })).process('vox-pop', 'p1');

            expect(patches).toEqual([{ trim: 'skipped' }]);
        });

        it('marks trim failed when the trimmer throws, leaving the variant alone', async () => {
            const failing = providers({
                trimmer: { trim: vi.fn(async () => { throw new Error('decode failed'); }) },
            });
            const { deps, patches } = makeDeps(makePost({
                processing: { trim: 'pending', updatedAt: new Date() },
            }));
            await new AudioProcessingService(deps, failing).process('vox-pop', 'p1');

            expect(patches).toEqual([{ trim: 'failed' }]);
            expect(deps.writeDerivedBlob).not.toHaveBeenCalled();
        });

        it('recomputes a ready transcript after trimming', async () => {
            // Trim is byte-mutating, so it invalidates derived artifacts the
            // same way denoise does — with no denoise involved at all.
            const { deps, patches, saved } = makeDeps(makePost({
                processing: { trim: 'pending', transcribe: 'ready', updatedAt: new Date() },
            }));
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(patches.some((patch) => patch.transcribe === 'pending')).toBe(true);
            expect(saved).toHaveLength(1);
            // Transcribed from the TRIMMED bytes, not the pre-trim audio.
            expect(Array.from(vi.mocked(p.transcriber!.transcribe).mock.calls[0][0].bytes)).toEqual([7]);
        });
    });

    describe('auto-recompute', () => {
        /** Denoise newly requested on a post that already carries a transcript. */
        const recomputeCase = (over: Partial<ProcessingState> = {}) =>
            makePost({
                processing: {
                    denoise: 'pending',
                    transcribe: 'ready',
                    updatedAt: new Date(),
                    ...over,
                },
            });

        it('re-transcribes the cleaned audio when denoise completes', async () => {
            const { deps, patches, saved } = makeDeps(recomputeCase());
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            // Marked pending before the re-run: a pass that dies mid-recompute
            // must leave outstanding work, not a `ready` stale transcript.
            expect(patches.some((patch) => patch.transcribe === 'pending')).toBe(true);
            expect(patches.some((patch) => patch.transcribe === 'ready')).toBe(true);
            expect(patches.findIndex((patch) => patch.transcribe === 'pending')).toBeLessThan(
                patches.findIndex((patch) => patch.transcribe === 'ready'),
            );
            expect(saved).toHaveLength(1);
            // The new transcript is of the DENOISER's output, not the original.
            const call = vi.mocked(p.transcriber!.transcribe).mock.calls[0][0];
            expect(Array.from(call.bytes)).toEqual([9, 9]);
        });

        it('leaves the derived artifact alone when reprocess is false', async () => {
            const { deps, patches, saved } = makeDeps(recomputeCase({ reprocess: false }));
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(saved).toEqual([]);
            expect(p.transcriber!.transcribe).not.toHaveBeenCalled();
            expect(patches.some((patch) => patch.transcribe === 'pending')).toBe(false);
            // Denoise itself still ran — opting out of recompute is not opting
            // out of the stage that triggered it.
            expect(deps.writeDerivedBlob).toHaveBeenCalledTimes(1);
        });

        it('never downgrades a ready stage the deployment cannot recompute', async () => {
            // A denoiser with no transcriber. Recomputing `transcribe` would
            // mark it pending, find no runner, and settle it `skipped` — i.e.
            // "never attempted", while the transcript of the OLD audio is still
            // saved and readable. Leaving it `ready` is stale but true.
            //
            // Currently unreachable via resolveProviders (both providers share
            // one API key), but trim in step 5 is local compute: it sets
            // variantChanged with no key configured, and so no transcriber.
            const denoiseOnly = providers({ transcriber: undefined });
            const { deps, patches, saved } = makeDeps(recomputeCase());
            await new AudioProcessingService(deps, denoiseOnly).process('vox-pop', 'p1');

            // Per-key, not toContainEqual: recompute writes ONE patch covering
            // every stage in the set, so a whole-object match stops seeing a
            // regression the moment a second derived stage is live.
            expect(patches.some((patch) => patch.transcribe === 'pending')).toBe(false);
            expect(patches.some((patch) => patch.transcribe === 'skipped')).toBe(false);
            expect(saved).toEqual([]);
            // The stage that could run still did.
            expect(deps.writeDerivedBlob).toHaveBeenCalledTimes(1);
        });

        it('does not recompute when the byte-mutating stage failed', async () => {
            const failing = providers({ denoiser: { denoise: vi.fn(async () => { throw new Error('nope'); }) } });
            const { deps, patches, saved } = makeDeps(recomputeCase());
            await new AudioProcessingService(deps, failing).process('vox-pop', 'p1');

            // No new variant ⇒ the existing transcript still describes the
            // audio being served, so recomputing it would only bill again.
            expect(patches).toContainEqual({ denoise: 'failed' });
            expect(patches).not.toContainEqual({ transcribe: 'pending' });
            expect(saved).toEqual([]);
        });

        it('does not recompute a derived stage that has no artifact yet', async () => {
            // transcribe `skipped`, not `ready` — nothing to invalidate.
            const post = makePost({
                processing: { denoise: 'pending', transcribe: 'skipped', updatedAt: new Date() },
            });
            const { deps, patches } = makeDeps(post);
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(patches).not.toContainEqual({ transcribe: 'pending' });
            expect(p.transcriber!.transcribe).not.toHaveBeenCalled();
        });

        it('never marks a byte-mutating stage pending — recompute cannot cascade', async () => {
            // The property that makes recompute terminate: derived stages are
            // pure analysis, so no byte-mutating stage depends on one. If this
            // ever fails, denoise→transcribe→denoise loops and bills forever.
            const post = makePost({
                processing: { denoise: 'pending', transcribe: 'ready', updatedAt: new Date() },
            });
            const { deps, patches } = makeDeps(post);
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            for (const stage of BYTE_MUTATING_STAGES) {
                expect(patches.filter((patch) => patch[stage] === 'pending')).toEqual([]);
            }
            expect(deps.writeDerivedBlob).toHaveBeenCalledTimes(1);
        });
    });

    describe('waveform', () => {
        it('writes the peaks and the ready status in one patch', async () => {
            const post = makePost({ processing: { waveform: 'pending', updatedAt: new Date() } });
            const { deps, patches } = makeDeps(post);
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            // One patch, not two. Split, a crash between them leaves `ready`
            // over absent peaks and no pending stage to make a retry fix it.
            expect(patches).toEqual([{ waveform: 'ready', waveformPeaks: [0, 50, 100] }]);
        });

        it('computes over the processed variant, not the original', async () => {
            // The whole point of running after the byte-mutating chain: peaks
            // of the original would describe audio the post no longer serves.
            const post = makePost({
                processing: { denoise: 'pending', waveform: 'pending', updatedAt: new Date() },
            });
            const { deps } = makeDeps(post);
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            const call = vi.mocked(p.waveform!.waveform).mock.calls[0][0];
            expect(Array.from(call.bytes)).toEqual([9, 9]);
        });

        it('recomputes when a byte-mutating stage changes the variant', async () => {
            const post = makePost({
                processing: { trim: 'pending', waveform: 'ready', updatedAt: new Date() },
            });
            const { deps, patches } = makeDeps(post);
            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(patches.findIndex((patch) => patch.waveform === 'pending')).toBeLessThan(
                patches.findIndex((patch) => patch.waveform === 'ready'),
            );
            // Trim re-encodes to mp3, so the peaks must come from those bytes.
            const call = vi.mocked(p.waveform!.waveform).mock.calls[0][0];
            expect(Array.from(call.bytes)).toEqual([7]);
            expect(call.mimeType).toBe('audio/mpeg');
        });

        it('settles skipped when no waveform provider is wired', async () => {
            const post = makePost({ processing: { waveform: 'pending', updatedAt: new Date() } });
            const { deps, patches } = makeDeps(post);
            await new AudioProcessingService(deps, providers({ waveform: undefined })).process(
                'vox-pop',
                'p1',
            );

            // `skipped`, never a permanent `pending` that reads as work in
            // flight — nothing was produced, so that reading is accurate.
            expect(patches).toEqual([{ waveform: 'skipped' }]);
        });

        it('leaves stale peaks ready when the variant changes with no runner', async () => {
            // The stranded case from step 4, now reachable for waveform:
            // marking it pending would settle it `skipped` — "never attempted"
            // — while the peaks it already produced stay saved and readable.
            const post = makePost({
                processing: { trim: 'pending', waveform: 'ready', updatedAt: new Date() },
            });
            const { deps, patches } = makeDeps(post);
            await new AudioProcessingService(deps, providers({ waveform: undefined })).process(
                'vox-pop',
                'p1',
            );

            expect(patches.some((patch) => patch.waveform !== undefined)).toBe(false);
        });

        it('fails the stage without touching the peaks when the provider throws', async () => {
            const post = makePost({ processing: { waveform: 'pending', updatedAt: new Date() } });
            const { deps, patches } = makeDeps(post);
            const failing = providers({
                waveform: { waveform: vi.fn(async () => { throw new Error('decode failed'); }) },
            });
            await new AudioProcessingService(deps, failing).process('vox-pop', 'p1');

            // No `waveformPeaks` key at all: a failed decode must leave the
            // client's original peaks in place rather than blanking them.
            expect(patches).toEqual([{ waveform: 'failed' }]);
        });

        it('does not suppress peaks when transcribe fails', async () => {
            // Both are derived and neither reads the other's artifact, so the
            // two must settle independently.
            const post = makePost({
                processing: { transcribe: 'pending', waveform: 'pending', updatedAt: new Date() },
            });
            const { deps, patches } = makeDeps(post);
            const failing = providers({
                transcriber: { transcribe: vi.fn(async () => { throw new Error('api down'); }) },
            });
            await new AudioProcessingService(deps, failing).process('vox-pop', 'p1');

            expect(patches).toContainEqual({ transcribe: 'failed' });
            expect(patches).toContainEqual({ waveform: 'ready', waveformPeaks: [0, 50, 100] });
        });
    });

    /**
     * The lease. Queue delivery is at-least-once, so these assert the property
     * that makes a duplicate delivery harmless: the second runner does no
     * work, bills nothing, and writes nothing.
     */
    describe('lease', () => {
        function pendingPost() {
            return makePost({
                processing: { denoise: 'pending', transcribe: 'pending', updatedAt: new Date() },
            });
        }

        it('does no work when the claim is declined', async () => {
            // The duplicate-delivery case. Without the lease both runners see
            // `denoise: 'pending'` and both pay ElevenLabs for the same post.
            const { deps, patches, saved } = makeDeps(pendingPost(), {
                claimProcessingLease: vi.fn(async () => false),
            });

            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(patches).toEqual([]);
            expect(saved).toEqual([]);
            expect(p.denoiser!.denoise).not.toHaveBeenCalled();
            // Not even read: a declined claim must cost one transaction, not a
            // full pass that happens to write nothing.
            expect(deps.getPostById).not.toHaveBeenCalled();
        });

        it('claims before reading the post', async () => {
            // Ordering is the whole point. A claim taken after the read would
            // let both runners load the same `pending` state first and only
            // then contend, which is the race with extra steps.
            const order: string[] = [];
            const { deps } = makeDeps(pendingPost(), {
                claimProcessingLease: vi.fn(async () => { order.push('claim'); return true; }),
                getPostById: vi.fn(async () => { order.push('read'); return null; }),
            });

            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(order).toEqual(['claim', 'read']);
        });

        it('claims a lease that expires ahead of the deps clock', async () => {
            const claim = vi.fn(async () => true);
            const { deps } = makeDeps(pendingPost(), { claimProcessingLease: claim });

            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            // Derived from `deps.now()`, not `Date.now()`, so the expiry is on
            // the same clock as every other timestamp the service writes.
            const [, , leaseUntil] = claim.mock.calls[0] as unknown as [string, string, Date];
            expect(leaseUntil.getTime()).toBe(
                new Date('2026-07-03T00:00:00Z').getTime() + 15 * 60 * 1000,
            );
        });

        it('releases the lease when the pass succeeds', async () => {
            const { deps } = makeDeps(pendingPost());

            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(deps.releaseProcessingLease).toHaveBeenCalledWith('vox-pop', 'p1');
        });

        it('releases the lease when the pass throws', async () => {
            // A stage's own try/catch settles it `failed`, but an error from
            // outside those blocks (storage down, here) escapes. Held to
            // expiry, the post would be unprocessable for the full TTL over a
            // fault that has already passed.
            const { deps } = makeDeps(pendingPost(), {
                getPostById: vi.fn(async () => { throw new Error('firestore down'); }),
            });

            await expect(
                new AudioProcessingService(deps, p).process('vox-pop', 'p1'),
            ).rejects.toThrow('firestore down');

            expect(deps.releaseProcessingLease).toHaveBeenCalledWith('vox-pop', 'p1');
        });

        it('does not release a lease it never held', async () => {
            // Releasing after a declined claim would clear the OTHER runner's
            // lease, handing its post to a third delivery mid-pass — turning
            // the safeguard into a way to cause the overlap.
            const { deps } = makeDeps(pendingPost(), {
                claimProcessingLease: vi.fn(async () => false),
            });

            await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

            expect(deps.releaseProcessingLease).not.toHaveBeenCalled();
        });
    });
});
