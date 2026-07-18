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
            expect(patches).toContainEqual({ transcribe: 'pending' });
            expect(patches).toContainEqual({ transcribe: 'ready' });
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
            expect(patches).not.toContainEqual({ transcribe: 'pending' });
            // Denoise itself still ran — opting out of recompute is not opting
            // out of the stage that triggered it.
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
});
