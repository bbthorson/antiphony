import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioPostService, buildPostUri, parsePostId, canonicalPostRecord, type CreateAudioPostInput } from './audio-posts';
import type { AudioPostDependencies } from '../ports/audio-posts-dependencies';
import type { AudioPostRecord, TranscriptEnrichmentRecord } from 'shared/types/audio';

/**
 * Pure unit tests for AudioPostService — no Firebase. A hand-rolled
 * in-memory `AudioPostDependencies` exercises the create/hydrate logic:
 * kind derivation, transcript lift, signed-URL resolution, viewer state,
 * batching (one transcript round per call), and origin-app scoping.
 */

const AUDIO_EMBED = {
    $type: 'dev.antiphony.embed.audio' as const,
    audio: { $type: 'blob' as const, ref: { $link: 'bafkreiaudio' }, mimeType: 'audio/webm', size: 2048 },
    durationMs: 4200,
    alt: 'spoken word',
    waveform: [0, 30, 90],
};

/** Deterministic per-tenant app DID for the fake — stands in for the boot-validated pin. */
const appDidFor = (originAppId: string) => `did:web:${originAppId}.example`;

function makeDeps(overrides: Partial<AudioPostDependencies> = {}): AudioPostDependencies {
    let counter = 0;
    const saved: AudioPostRecord[] = [];
    return {
        newPostId: vi.fn(() => `post-${++counter}`),
        getAppDid: vi.fn((originAppId: string) => appDidFor(originAppId)),
        savePost: vi.fn(async (r: AudioPostRecord) => { saved.push(r); }),
        getPostById: vi.fn(async () => null),
        queryByAuthor: vi.fn(async () => []),
        queryByRootAuthor: vi.fn(async () => []),
        queryReplies: vi.fn(async () => []),
        getTranscriptsBySubjectUris: vi.fn(async () => new Map<string, TranscriptEnrichmentRecord>()),
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
    it('uses the app DID as the at:// authority (not the author), post id as the last segment', () => {
        expect(buildPostUri('did:web:voxpop.com', 'p1'))
            .toBe('at://did:web:voxpop.com/dev.antiphony.audio.post/p1');
    });
});

describe('parsePostId', () => {
    const APP_DID = 'did:web:voxpop.com';

    it('extracts the rkey when the authority matches, tolerating a trailing slash; null when empty', () => {
        expect(parsePostId('at://did:web:voxpop.com/dev.antiphony.audio.post/p1', APP_DID)).toBe('p1');
        expect(parsePostId('at://did:web:voxpop.com/dev.antiphony.audio.post/p1/', APP_DID)).toBe('p1');
        expect(parsePostId(buildPostUri(APP_DID, 'p9'), APP_DID)).toBe('p9');
        expect(parsePostId('', APP_DID)).toBeNull();
    });

    it('rejects a StrongRef whose authority is a different (cross-tenant/forged) app DID', () => {
        // Same rkey, wrong authority ⇒ null, so it can't resolve inside our tenant.
        expect(parsePostId('at://did:web:evil.com/dev.antiphony.audio.post/p1', APP_DID)).toBeNull();
        expect(parsePostId(buildPostUri('did:web:bardcast.com', 'p1'), APP_DID)).toBeNull();
    });

    it('rejects a malformed uri (non-at://, or missing collection/rkey)', () => {
        expect(parsePostId('at://did:web:voxpop.com', APP_DID)).toBeNull();
        expect(parsePostId('https://voxpop.com/x/y/p1', APP_DID)).toBeNull();
    });

    it('rejects a ref to a different collection (cross-collection spoofing)', () => {
        // Right authority, wrong collection ⇒ null, so it can't masquerade as a post.
        expect(parsePostId('at://did:web:voxpop.com/app.bsky.feed.post/p1', APP_DID)).toBeNull();
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
        // Parent authority must be the tenant's own app DID (post is originAppId 'vox-pop').
        const ref = { uri: buildPostUri(appDidFor('vox-pop'), 'root'), cid: 'root' };
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
        const parentRef = { uri: buildPostUri(appDidFor(parent.originAppId), parent.id), cid: parent.id };
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

    it('stamps rootAuthorId = the prompt author on a top-level reply, with no extra read', async () => {
        setParent(prompt);
        const rec = await svc.createPost(replyTo(prompt, 'responder'));
        // The prompt IS the thread root → its author is the recipient facet.
        expect(rec.rootAuthorId).toBe('creator');
        // Only the parent was fetched — the root is derived, not looked up.
        expect(deps.getPostById).toHaveBeenCalledTimes(1);
    });

    it('inherits rootAuthorId down the branch on a reply-to-reply (no extra read)', async () => {
        const parentReply = {
            id: 'r1', originAppId: 'vox-pop', authorId: 'responder', kind: 'reply',
            threadParticipants: ['creator', 'responder'], rootAuthorId: 'creator',
            text: 'a reply', reply: { root: rootRef, parent: rootRef }, createdAt: new Date(),
        } as AudioPostRecord;
        setParent(parentReply);
        const rec = await svc.createPost(replyTo(parentReply, 'creator'));
        // Inherited from parent.rootAuthorId, not re-derived from the root uri.
        expect(rec.rootAuthorId).toBe('creator');
        expect(deps.getPostById).toHaveBeenCalledTimes(1);
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

    it('rejects a reply whose parent StrongRef carries a foreign (cross-tenant) authority', async () => {
        // The parent post EXISTS (getPostById would return it), but the ref's
        // authority is another tenant's app DID. The parse-time authority check
        // rejects it BEFORE the lookup, so a forged cross-tenant StrongRef can't
        // open a branch inside this tenant.
        setParent(prompt);
        const forged = { uri: buildPostUri('did:web:bardcast.com', prompt.id), cid: prompt.id };
        const input = promptInput({ authorId: 'responder', text: 'a reply', reply: { root: rootRef, parent: forged } });
        await expect(svc.createPost(input)).rejects.toMatchObject({ status: 404 });
        expect(deps.getPostById).not.toHaveBeenCalled();
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
        const recUri = buildPostUri(appDidFor(rec.originAppId), rec.id);
        (deps.getTranscriptsBySubjectUris as ReturnType<typeof vi.fn>).mockResolvedValue(
            new Map([[recUri, { id: 't1', subject: { uri: recUri, cid: 'p1' }, transcript, createdAt: new Date() }]]),
        );

        const [view] = await svc.hydrateAudioPosts([rec], null);
        // Signed via (originAppId, blobCid) — tenancy-scoped, CID-derived path.
        expect(view.embed?.url).toBe(`signed::vox-pop::${AUDIO_EMBED.audio.ref.$link}`);
        expect(view.embed?.$type).toBe('dev.antiphony.embed.audio#view');
        expect(view.embed?.transcript).toEqual(transcript);
        expect(view.embed?.durationMs).toBe(4200);
        // No processing requested ⇒ no processing block on the view.
        expect(view.embed?.processing).toBeUndefined();
    });

    it('surfaces per-stage processing status on the embed view', async () => {
        const rec = record({ processing: { transcribe: 'pending', denoise: 'ready', denoisedBlobCid: 'bafkreiclean', updatedAt: new Date() } });
        const [view] = await svc.hydrateAudioPosts([rec], null);
        expect(view.embed?.processing).toEqual({ transcribe: 'pending', denoise: 'ready' });
        // Internal storage fields (denoisedBlobCid, updatedAt) never leak to the view.
        expect(view.embed?.processing).not.toHaveProperty('denoisedBlobCid');
    });

    it('resolves playback to the denoised variant once denoise is ready', async () => {
        const rec = record({ processing: { denoise: 'ready', denoisedBlobCid: 'bafkreiclean', updatedAt: new Date() } });
        const [view] = await svc.hydrateAudioPosts([rec], null);
        // Playback signs the DENOISED cid, not the original embed cid.
        expect(view.embed?.url).toBe('signed::vox-pop::bafkreiclean');
    });

    it('keeps playback on the original audio while denoise is still pending', async () => {
        const rec = record({ processing: { denoise: 'pending', updatedAt: new Date() } });
        const [view] = await svc.hydrateAudioPosts([rec], null);
        expect(view.embed?.url).toBe(`signed::vox-pop::${AUDIO_EMBED.audio.ref.$link}`);
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

    it('batches the transcript load once for the whole set (no N+1)', async () => {
        await svc.hydrateAudioPosts([record({ id: 'a' }), record({ id: 'b' }), record({ id: 'c' })], null);
        expect(deps.getTranscriptsBySubjectUris).toHaveBeenCalledTimes(1);
    });

    it('carries opaque author refs straight off the record (no profile lookup)', async () => {
        const [view] = await svc.hydrateAudioPosts(
            [record({ authorId: 'u1', authorDid: 'did:web:voxpop.audio' })],
            null,
        );
        expect(view.authorId).toBe('u1');
        expect(view.authorDid).toBe('did:web:voxpop.audio');
        expect(view).not.toHaveProperty('author');
    });

    it('omits authorDid when the record carries none', async () => {
        const [view] = await svc.hydrateAudioPosts([record()], null);
        expect(view.authorId).toBe('u1');
        expect(view.authorDid).toBeUndefined();
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
        expect(deps.getTranscriptsBySubjectUris).not.toHaveBeenCalled();
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

    it('drops explicitly-undefined embed optionals (DAG-CBOR rejects undefined)', () => {
        const canonical = canonicalPostRecord({
            text: 'x',
            embed: { ...AUDIO_EMBED, durationMs: undefined, alt: undefined, waveform: undefined },
            createdAt,
        });
        const embed = canonical.embed as Record<string, unknown>;
        expect(Object.keys(embed).sort()).toEqual(['$type', 'audio']);
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

describe('getRepliesByRootAuthor', () => {
    const replyRecord = {
        id: 'r1', originAppId: 'vox-pop', authorId: 'responder', kind: 'reply',
        threadParticipants: ['creator', 'responder'], rootAuthorId: 'creator',
        text: 'a reply', embed: AUDIO_EMBED,
        reply: {
            root: { uri: 'at://did:web:vox-pop.example/dev.antiphony.audio.post/root', cid: 'root' },
            parent: { uri: 'at://did:web:vox-pop.example/dev.antiphony.audio.post/root', cid: 'root' },
        },
        createdAt: new Date('2026-06-26T00:00:00Z'),
    } as AudioPostRecord;

    it('queries by rootAuthor within the origin app and hydrates the results', async () => {
        const deps = makeDeps({ queryByRootAuthor: vi.fn(async () => [replyRecord]) });
        const svc = new AudioPostService(deps);

        const views = await svc.getRepliesByRootAuthor('vox-pop', 'creator', 'creator', { limit: 25, cursorId: 'r0' });

        expect(deps.queryByRootAuthor).toHaveBeenCalledWith('vox-pop', 'creator', { limit: 25, cursorId: 'r0' });
        expect(views).toHaveLength(1);
        expect(views[0].kind).toBe('reply');
        // Hydration ran (signed url resolved) — same path as the other reads.
        expect(views[0].embed?.url).toBe(`signed::vox-pop::${AUDIO_EMBED.audio.ref.$link}`);
    });

    it('returns [] when the author addresses no replies', async () => {
        const deps = makeDeps(); // queryByRootAuthor defaults to []
        const svc = new AudioPostService(deps);
        expect(await svc.getRepliesByRootAuthor('vox-pop', 'nobody', null)).toEqual([]);
    });
});

describe('setProcessing', () => {
    const post = {
        id: 'p1', originAppId: 'vox-pop', authorId: 'u1', kind: 'prompt',
        text: 'hi', embed: AUDIO_EMBED, createdAt: new Date('2026-06-26T00:00:00Z'),
    } as AudioPostRecord;

    function depsWith(record: AudioPostRecord | null) {
        return makeDeps({ getPostById: vi.fn(async () => record) });
    }

    it('merges the resolved stages over existing state and stamps updatedAt', async () => {
        const existing = { ...post, processing: { transcribe: 'ready', updatedAt: new Date('2026-06-01T00:00:00Z') } } as AudioPostRecord;
        const deps = depsWith(existing);
        const svc = new AudioPostService(deps);

        const updated = await svc.setProcessing('vox-pop', 'p1', 'u1', { denoise: 'pending' });

        // denoise added; the already-ready transcribe is NOT clobbered.
        expect(updated.processing).toMatchObject({ transcribe: 'ready', denoise: 'pending' });
        expect(updated.processing?.updatedAt).toEqual(new Date('2026-06-26T00:00:00Z'));
        expect(deps.savePost).toHaveBeenCalledWith(updated);
    });

    it('404s when the post is missing (or cross-tenant)', async () => {
        const svc = new AudioPostService(depsWith(null));
        await expect(svc.setProcessing('vox-pop', 'nope', 'u1', { transcribe: 'pending' }))
            .rejects.toMatchObject({ status: 404 });
    });

    it('403s when the actor is not the post author, and saves nothing', async () => {
        const deps = depsWith(post);
        const svc = new AudioPostService(deps);
        await expect(svc.setProcessing('vox-pop', 'p1', 'someone-else', { transcribe: 'pending' }))
            .rejects.toMatchObject({ status: 403 });
        expect(deps.savePost).not.toHaveBeenCalled();
    });

    it('400s when the post has no audio to process', async () => {
        const deps = depsWith({ ...post, embed: undefined } as AudioPostRecord);
        const svc = new AudioPostService(deps);
        await expect(svc.setProcessing('vox-pop', 'p1', 'u1', { transcribe: 'pending' }))
            .rejects.toMatchObject({ status: 400 });
    });
});
