import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioPostService, buildPostUri, parsePostId, canonicalPostRecord, type CreateAudioPostInput } from './audio-posts';
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
    audio: { $type: 'blob' as const, ref: { $link: 'bafkreiaudio' }, mimeType: 'audio/webm', size: 2048 },
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
        signAudioUrl: vi.fn(async (originAppId: string, blobCid: string) => `signed::${originAppId}::${blobCid}`),
        cidForRecord: vi.fn(async () => 'bafyreitestcid'),
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

describe('parsePostId', () => {
    it('extracts the id (last segment), tolerating a trailing slash; null when empty', () => {
        expect(parsePostId('at://did:plc:abc/dev.antiphony.audio.post/p1')).toBe('p1');
        expect(parsePostId('at://did:plc:abc/dev.antiphony.audio.post/p1/')).toBe('p1');
        expect(parsePostId(buildPostUri({ id: 'p9', authorId: 'u1' }))).toBe('p9');
        expect(parsePostId('')).toBeNull();
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
        expect(rec.cid).toBe('bafyreitestcid');
        expect(rec.createdAt).toEqual(new Date('2026-06-26T00:00:00Z'));
        expect(deps.savePost).toHaveBeenCalledWith(rec);
        // The CID is computed over the canonical lexicon projection — public
        // fields only, never storage/tenancy fields.
        const canonical = vi.mocked(deps.cidForRecord).mock.calls[0][0];
        expect(canonical.$type).toBe('dev.antiphony.audio.post');
        expect(canonical).not.toHaveProperty('id');
        expect(canonical).not.toHaveProperty('originAppId');
        expect(canonical).not.toHaveProperty('authorId');
        expect(canonical).not.toHaveProperty('kind');
    });

    it('derives kind=reply and drops any title when a reply ref is present', async () => {
        const ref = { uri: 'at://u1/dev.antiphony.audio.post/root', cid: 'root' };
        (deps.getPostById as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'root', originAppId: 'vox-pop', authorId: 'creator', kind: 'prompt',
            text: 'the prompt', createdAt: new Date('2026-06-20T00:00:00Z'),
        } as AudioPostRecord);
        const rec = await svc.createPost(promptInput({
            authorId: 'u1', text: '', title: 'should be dropped', reply: { root: ref, parent: ref },
        }));
        expect(rec.kind).toBe('reply');
        expect(rec.title).toBeUndefined();
        expect(rec.reply?.parent.uri).toBe(ref.uri);
    });
});

describe('reply gating (createPost, §6)', () => {
    let deps: AudioPostDependencies;
    let svc: AudioPostService;
    beforeEach(() => { deps = makeDeps(); svc = new AudioPostService(deps); });

    const prompt = {
        id: 'root', originAppId: 'vox-pop', authorId: 'creator', kind: 'prompt',
        text: 'the prompt', createdAt: new Date('2026-06-20T00:00:00Z'),
    } as AudioPostRecord;
    const rootRef = { uri: 'at://creator/dev.antiphony.audio.post/root', cid: 'root' };

    function replyTo(parent: AudioPostRecord, authorId: string): CreateAudioPostInput {
        const parentRef = { uri: buildPostUri(parent), cid: parent.id };
        return promptInput({ authorId, text: 'a reply', reply: { root: rootRef, parent: parentRef } });
    }

    function setParent(rec: AudioPostRecord | null) {
        (deps.getPostById as ReturnType<typeof vi.fn>).mockResolvedValue(rec);
    }

    it('opens a {creator, responder} pair for a top-level reply to a prompt', async () => {
        setParent(prompt);
        const rec = await svc.createPost(replyTo(prompt, 'responder'));
        expect(rec.kind).toBe('reply');
        expect([...(rec.threadParticipants ?? [])].sort()).toEqual(['creator', 'responder']);
    });

    it('collapses a creator self-reply to a single participant', async () => {
        setParent(prompt);
        const rec = await svc.createPost(replyTo(prompt, 'creator'));
        expect(rec.threadParticipants).toEqual(['creator']);
    });

    it('404s when the parent is missing or cross-tenant, and saves nothing', async () => {
        setParent(null);
        await expect(svc.createPost(replyTo(prompt, 'responder'))).rejects.toMatchObject({ status: 404 });
        expect(deps.savePost).not.toHaveBeenCalled();
    });

    it('lets a branch participant continue, inheriting the pair', async () => {
        const reply = {
            id: 'r1', originAppId: 'vox-pop', authorId: 'responder', kind: 'reply',
            threadParticipants: ['creator', 'responder'], text: 'a reply',
            reply: { root: rootRef, parent: rootRef }, createdAt: new Date(),
        } as AudioPostRecord;
        setParent(reply);
        const rec = await svc.createPost(replyTo(reply, 'creator')); // creator answers back
        expect([...(rec.threadParticipants ?? [])].sort()).toEqual(['creator', 'responder']);
    });

    it('403s when a non-participant replies to a reply, and saves nothing', async () => {
        const reply = {
            id: 'r1', originAppId: 'vox-pop', authorId: 'responder', kind: 'reply',
            threadParticipants: ['creator', 'responder'], text: 'a reply',
            reply: { root: rootRef, parent: rootRef }, createdAt: new Date(),
        } as AudioPostRecord;
        setParent(reply);
        await expect(svc.createPost(replyTo(reply, 'stranger'))).rejects.toMatchObject({ status: 403 });
        expect(deps.savePost).not.toHaveBeenCalled();
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
        // Signed via (originAppId, blobCid) — tenancy-scoped, CID-derived path.
        expect(view.embed?.url).toBe(`signed::vox-pop::${AUDIO_EMBED.audio.ref.$link}`);
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

    it('prompt: any authenticated viewer canReply; anonymous cannot', async () => {
        const [auth] = await svc.hydrateAudioPosts([record()], 'anyone');
        const [anon] = await svc.hydrateAudioPosts([record()], null);
        expect(auth.viewer.canReply).toBe(true);
        expect(auth.viewer.replyDisabledReason).toBeUndefined();
        expect(anon.viewer.canReply).toBe(false);
        expect(anon.viewer.replyDisabledReason).toBe('unauthenticated');
    });

    it('reply: only branch participants canReply; others get not_a_participant', async () => {
        const replyRec = record({
            id: 'r1', kind: 'reply', threadParticipants: ['creator', 'responder'],
            reply: {
                root: { uri: 'at://creator/dev.antiphony.audio.post/root', cid: 'root' },
                parent: { uri: 'at://creator/dev.antiphony.audio.post/root', cid: 'root' },
            },
        });
        const [participant] = await svc.hydrateAudioPosts([replyRec], 'responder');
        const [stranger] = await svc.hydrateAudioPosts([replyRec], 'stranger');
        expect(participant.viewer.canReply).toBe(true);
        expect(stranger.viewer.canReply).toBe(false);
        expect(stranger.viewer.replyDisabledReason).toBe('not_a_participant');
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

describe('canonicalPostRecord (record-CID projection)', () => {
    const createdAt = new Date('2026-06-26T00:00:00Z');

    it('emits only present lexicon fields, with $type and ISO createdAt', () => {
        const canonical = canonicalPostRecord({ text: 'hi', createdAt });
        expect(canonical).toEqual({
            $type: 'dev.antiphony.audio.post',
            text: 'hi',
            createdAt: '2026-06-26T00:00:00.000Z',
        });
        // Absent optionals are OMITTED, not present-as-undefined — key
        // presence changes the DAG-CBOR encoding and therefore the CID.
        expect(Object.keys(canonical)).toEqual(['$type', 'text', 'createdAt']);
    });

    it('stamps the embed $type and expands selfLabels to the lexicon union shape', () => {
        const canonical = canonicalPostRecord({
            text: '', embed: AUDIO_EMBED, selfLabels: ['nsfw'], createdAt,
        });
        expect((canonical.embed as { $type: string }).$type).toBe('dev.antiphony.embed.audio');
        expect(canonical.labels).toEqual({
            $type: 'com.atproto.label.defs#selfLabels',
            values: [{ val: 'nsfw' }],
        });
        expect(canonical).not.toHaveProperty('selfLabels');
    });

    it('omits an empty selfLabels array entirely', () => {
        const canonical = canonicalPostRecord({ text: 'x', selfLabels: [], createdAt });
        expect(canonical).not.toHaveProperty('labels');
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
