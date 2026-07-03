import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioProcessingService, type ProcessingProviders } from './audio-processing';
import { buildPostUri } from './audio-posts';
import type { AudioProcessingDependencies } from '../ports/audio-processing-dependencies';
import type { AudioPostRecord, TranscriptEnrichmentRecord } from 'shared/types/audio';
import type { ProcessingState } from 'shared/types/processing';

const AUDIO_CID = 'bafkreioriginal';
const CLEANED_CID = 'bafkreicleaned';

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
        expect(saved[0].subject).toEqual({ uri: buildPostUri(post), cid: post.cid });
        expect(saved[0].transcript.text).toBe('hello');
        expect(saved[0].model).toBe('stub-1');
        expect(patches).toContainEqual({ transcribe: 'ready' });
    });

    it('denoises: writes a derived blob and records its CID', async () => {
        const post = makePost({ processing: { denoise: 'pending', updatedAt: new Date() } });
        const { deps, patches } = makeDeps(post);
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

        expect(deps.writeDerivedBlob).toHaveBeenCalledTimes(1);
        expect(patches).toContainEqual({ denoise: 'ready', denoisedBlobCid: CLEANED_CID });
    });

    it('runs denoise before transcribe, and transcribes the CLEANED audio', async () => {
        const post = makePost({ processing: { transcribe: 'pending', denoise: 'pending', updatedAt: new Date() } });
        const { deps } = makeDeps(post);
        await new AudioProcessingService(deps, p).process('vox-pop', 'p1');

        // Transcriber received the denoiser's output bytes ([9,9]), not the original ([1,2,3]).
        const call = vi.mocked(p.transcriber!.transcribe).mock.calls[0][0];
        expect(Array.from(call.bytes)).toEqual([9, 9]);
    });

    it('marks a requested stage skipped when its provider is absent', async () => {
        const post = makePost({ processing: { transcribe: 'pending', denoise: 'pending', updatedAt: new Date() } });
        const { deps, patches, saved } = makeDeps(post);
        await new AudioProcessingService(deps, {}).process('vox-pop', 'p1');
        expect(patches).toContainEqual({ transcribe: 'skipped' });
        expect(patches).toContainEqual({ denoise: 'skipped' });
        expect(saved).toEqual([]);
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
});
