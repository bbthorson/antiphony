import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioPostService, buildPostUri, type CreateAudioPostInput } from './audio-posts';
import type { AudioPostDependencies } from '../ports/audio-posts-dependencies';
import type { AudioPostRecord, TranscriptEnrichmentRecord } from 'shared/types/audio';
import type { ProfileViewBasic } from 'shared/types/views';

/**
 * Pure unit tests for AudioPostService — no Firebase. A hand-rolled
 * in-memory `AudioPostDependencies` exercises the create/hydrate logic:
 * kind derivation, transcript lift, signed-URL resolution, viewer state,
 * batching (one author/transcript round per call), and origin-app scoping.
 */

const AUDIO_EMBED = {
    $type: 'dev.antiphony.embed.audio' as const,
    audio: { $type: 'blob' as const, ref: 'https://storage.example/audio/u1/a.webm', mimeType: 'audio/webm', size: 2048 },
    durationMs: 4200,
    alt: 'spoken word',
    waveform: [0, 30, 90],
};

const AUTHOR: ProfileViewBasic = { id: 'u1', handle: 'alice', displayName: 'Alice' };

function makeDeps(overrides: Partial<AudioPostDependencies> = {}): AudioPostDependencies {
    let counter = 0;
    const saved: AudioPostRecord[] = [];
    return {
        newPostId: vi.fn(() => `post-${++counter}`),
        savePost: vi.fn(async (r: AudioPostRecord) => { saved.push(r); }),
        getPostById: vi.fn(async () => null),
        queryByAuthor: vi.fn(async () => []),
        queryReplies: vi.fn(async () => []),
        getTranscriptsBySubjectUris: vi.fn(async () => new Map<string, TranscriptEnrichmentRecord>()),
        getAuthorsByIds: vi.fn(async () => new Map([[AUTHOR.id, AUTHOR]])),
        signAudioUrl: vi.fn(async (url: string) => `signed::${url}`),
        now: vi.fn(() => new Date('2026-06-26T00:00:00Z')),
        ...overrides,
        // expose saved for assertions without widening the interface
        ...({ __saved: saved } as object),
    } as AudioPostDependencies;
}

function promptInput(over: Partial<CreateAudioPostInput> = {}): CreateAudioPostInput {
    return { originAppId: 'vox-pop', authorId: 'u1', text: 'a question', embed: AUDIO_EMBED, ...over };
}

describe('buildPostUri', () => {
    it('uses the DID when present, else the author id, with the post id as the last segment', () => {
        expect(buildPostUri({ id: 'p1', authorId: 'u1', authorDid: 'did:plc:abc' }))
            .toBe('at://did:plc:abc/dev.antiphony.audio.post/p1');
        expect(buildPostUri({ id: 'p1', authorId: 'u1' }))
            .toBe('at://u1/dev.antiphony.audio.post/p1');
    });
});

describe('createPost', () => {
    let deps: AudioPostDependencies;
    let svc: AudioPostService;
    beforeEach(() => { deps = makeDeps(); svc = new AudioPostService(deps); });

    it('derives kind=prompt and keeps the title when there is no reply', async () => {
        const rec = await svc.createPost(promptInput({ title: 'Headline' }));
        expect(rec.kind).toBe('prompt');
        expect(rec.title).toBe('Headline');
        expect(rec.reply).toBeUndefined();
        expect(rec.id).toBe('post-1');
        expect(rec.createdAt).toEqual(new Date('2026-06-26T00:00:00Z'));
        expect(deps.savePost).toHaveBeenCalledWith(rec);
    });

    it('derives kind=reply and drops any title when a reply ref is present', async () => {
        const ref = { uri: 'at://u1/dev.antiphony.audio.post/root', cid: 'root' };
        const rec = await svc.createPost(promptInput({
            text: '', title: 'should be dropped', reply: { root: ref, parent: ref },
        }));
        expect(rec.kind).toBe('reply');
        expect(rec.title).toBeUndefined();
        expect(rec.reply?.parent.uri).toBe(ref.uri);
    });
});

describe('hydrateAudioPosts', () => {
    let deps: AudioPostDependencies;
    let svc: AudioPostService;
    beforeEach(() => { deps = makeDeps(); svc = new AudioPostService(deps); });

    function record(over: Partial<AudioPostRecord> = {}): AudioPostRecord {
        return {
            id: 'p1', originAppId: 'vox-pop', authorId: 'u1', kind: 'prompt',
            text: 'hi', embed: AUDIO_EMBED, createdAt: new Date('2026-06-26T00:00:00Z'), ...over,
        } as AudioPostRecord;
    }

    it('signs the audio url and lifts the transcript onto the embed view', async () => {
        const rec = record();
        const transcript = { segments: [{ startMs: 0, endMs: 500, text: 'hi' }], text: 'hi' };
        (deps.getTranscriptsBySubjectUris as ReturnType<typeof vi.fn>).mockResolvedValue(
            new Map([[buildPostUri(rec), { id: 't1', subject: { uri: buildPostUri(rec), cid: 'p1' }, transcript, createdAt: new Date() }]]),
        );

        const [view] = await svc.hydrateAudioPosts([rec], null);
        expect(view.embed?.url).toBe(`signed::${AUDIO_EMBED.audio.ref}`);
        expect(view.embed?.$type).toBe('dev.antiphony.embed.audio#view');
        expect(view.embed?.transcript).toEqual(transcript);
        expect(view.embed?.durationMs).toBe(4200);
    });

    it('computes viewer.isAuthor from the viewer uid', async () => {
        const [mine] = await svc.hydrateAudioPosts([record()], 'u1');
        const [theirs] = await svc.hydrateAudioPosts([record()], 'someone-else');
        const [anon] = await svc.hydrateAudioPosts([record()], null);
        expect(mine.viewer.isAuthor).toBe(true);
        expect(theirs.viewer.isAuthor).toBe(false);
        expect(anon.viewer.isAuthor).toBe(false);
    });

    it('batches author + transcript loads once for the whole set (no N+1)', async () => {
        await svc.hydrateAudioPosts([record({ id: 'a' }), record({ id: 'b' }), record({ id: 'c' })], null);
        expect(deps.getAuthorsByIds).toHaveBeenCalledTimes(1);
        expect(deps.getTranscriptsBySubjectUris).toHaveBeenCalledTimes(1);
    });

    it('falls back to a synthetic author when the profile is missing', async () => {
        (deps.getAuthorsByIds as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
        const [view] = await svc.hydrateAudioPosts([record()], null);
        expect(view.author.id).toBe('u1');
        expect(view.author.displayName).toBe('Unknown User');
    });

    it('omits the embed when there is no audio', async () => {
        const [view] = await svc.hydrateAudioPosts([record({ embed: undefined })], null);
        expect(view.embed).toBeUndefined();
        expect(deps.signAudioUrl).not.toHaveBeenCalled();
    });

    it('omits the embed when the audio url cannot be signed', async () => {
        (deps.signAudioUrl as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const [view] = await svc.hydrateAudioPosts([record()], null);
        expect(view.embed).toBeUndefined();
    });

    it('returns [] for an empty input without touching the loaders', async () => {
        expect(await svc.hydrateAudioPosts([], null)).toEqual([]);
        expect(deps.getAuthorsByIds).not.toHaveBeenCalled();
    });
});

describe('getPostView / getReplies pass-through', () => {
    it('scopes getPostView by originAppId and returns null when the post is absent (cross-tenant)', async () => {
        const deps = makeDeps();
        const svc = new AudioPostService(deps);
        const view = await svc.getPostView('other-app', 'p1', null);
        expect(view).toBeNull();
        expect(deps.getPostById).toHaveBeenCalledWith('other-app', 'p1');
    });

    it('keys the thread query on the supplied parent uri', async () => {
        const deps = makeDeps();
        const svc = new AudioPostService(deps);
        await svc.getReplies('vox-pop', 'at://u1/dev.antiphony.audio.post/root', null, { limit: 10 });
        expect(deps.queryReplies).toHaveBeenCalledWith('vox-pop', 'at://u1/dev.antiphony.audio.post/root', { limit: 10 });
    });
});
