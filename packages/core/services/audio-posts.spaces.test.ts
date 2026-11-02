import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    AudioPostService,
    buildPostUri,
    buildRecordUri,
    parsePostId,
    parsePostUri,
    type CreateAudioPostInput,
} from './audio-posts';
import { inMemoryAudioPostDependencies, type InMemoryAudioPostDependencies } from '../testing/in-memory-audio-post-dependencies';
import type { AudioPostRecord } from 'shared/types/audio';
import type { SpacePlacement } from 'shared/types/spaces';

/**
 * atproto spaces, Phase 1 (specs/spaces.md): space-aware post URIs, and
 * placement through `createPost` and hydration. Flat behaviour is covered by
 * audio-posts.test.ts and must not change. The 2026-10-11 revisions: the author
 * segment is the authority's DID (atproto-authority-model.md D8), and a reply to
 * a flat post may name a space (cross-repo-design.md §3.2).
 */

const APP = 'did:web:bardcast.example';
const appDidFor = (originAppId: string) => (originAppId === 'bardcast' ? APP : `did:web:${originAppId}.example`);
const PLAYER = 'did:plc:abc123player';
const OTHER_PLAYER = 'did:plc:xyz789other';
const CAMPAIGN: SpacePlacement = { type: 'game.bardcast.space.campaign', skey: '3kcampaign2abc', authorSegment: APP };

describe('space post URIs', () => {
    it('builds the space shape through @atproto/syntax', () => {
        expect(buildPostUri(APP, '3kabc2def3ghi', CAMPAIGN)).toBe(
            `at://${APP}/space/game.bardcast.space.campaign/3kcampaign2abc/${APP}/dev.antiphony.audio.post/3kabc2def3ghi`,
        );
    });

    it('leaves the flat shape byte-identical', () => {
        expect(buildPostUri(APP, 'p1')).toBe(`at://${APP}/dev.antiphony.audio.post/p1`);
        expect(buildRecordUri({ authority: APP, collection: 'dev.antiphony.audio.post', rkey: 'p1' })).toBe(
            `at://${APP}/dev.antiphony.audio.post/p1`,
        );
    });

    it('round-trips a space uri, placement included', () => {
        const uri = buildPostUri(APP, '3kabc2def3ghi', CAMPAIGN);
        expect(parsePostUri(uri, APP)).toEqual({ authority: APP, id: '3kabc2def3ghi', space: CAMPAIGN });
        expect(parsePostId(uri, APP)).toBe('3kabc2def3ghi');
    });

    it('accepts a DID as the space key (a per-player space)', () => {
        const mine: SpacePlacement = { type: 'game.bardcast.space.player', skey: PLAYER, authorSegment: APP };
        const uri = buildPostUri(APP, '3kabc2def3ghi', mine);
        expect(parsePostUri(uri, APP)).toEqual({ authority: APP, id: '3kabc2def3ghi', space: mine });
    });

    it('rejects a space uri from another tenant', () => {
        const foreign = buildPostUri('did:web:evil.example', '3kabc2def3ghi', CAMPAIGN);
        expect(parsePostUri(foreign, APP)).toBeNull();
    });

    it('rejects space uris that are not posts this service would mint', () => {
        const base = `at://${APP}/space/game.bardcast.space.campaign/3kcampaign2abc`;
        expect(parsePostUri(base, APP)).toBeNull(); // the space itself, not a record
        expect(parsePostUri(`${base}/${PLAYER}/app.bsky.feed.post/3kabc2def3ghi`, APP)).toBeNull(); // other collection
        expect(parsePostUri(`${base}/not-a-did/dev.antiphony.audio.post/3kabc2def3ghi`, APP)).toBeNull();
        expect(parsePostUri(`${base}/${PLAYER}/dev.antiphony.audio.post/3kabc2def3ghi/extra`, APP)).toBeNull();
        expect(parsePostUri(`at://${APP}/space/not_an_nsid/3kcampaign2abc/${PLAYER}/dev.antiphony.audio.post/x`, APP)).toBeNull();
    });

    it('refuses to mint a space uri from invalid parts', () => {
        expect(() => buildPostUri(APP, 'p1', { ...CAMPAIGN, type: 'nope' })).toThrow(/NSID/);
        expect(() => buildPostUri(APP, 'p1', { ...CAMPAIGN, skey: 'has space' })).toThrow(/record key/);
        expect(() => buildPostUri(APP, 'p1', { ...CAMPAIGN, authorSegment: 'alice' })).toThrow(/DID/);
    });
});

/**
 * The shared in-memory store (`testing/in-memory-audio-post-dependencies.ts`),
 * which runs the same contract as the Postgres binding, with each method
 * wrapped in a spy for the call assertions below.
 */
function makeDeps(): InMemoryAudioPostDependencies {
    const deps = inMemoryAudioPostDependencies({
        getAppDid: appDidFor,
        resolveAudioUrl: async () => 'https://audio.example/x',
        now: () => new Date('2026-10-07T00:00:00Z'),
    });
    const spied = deps as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(deps)) {
        if (typeof value === 'function') spied[name] = vi.fn(value as (...args: unknown[]) => unknown);
    }
    return deps;
}

const input = (over: Partial<CreateAudioPostInput> = {}): CreateAudioPostInput => ({
    originAppId: 'bardcast',
    authorId: 'dm',
    text: 'the scene',
    ...over,
});

describe('createPost in a space', () => {
    let deps: ReturnType<typeof makeDeps>;
    let svc: AudioPostService;
    beforeEach(() => {
        deps = makeDeps();
        deps.spaces.add(`bardcast/${CAMPAIGN.type}/${CAMPAIGN.skey}`);
        svc = new AudioPostService(deps);
    });

    const refTo = (post: AudioPostRecord) => ({ uri: buildPostUri(APP, post.id, post.space), cid: post.cid });

    it("places a prompt in the space it names, with the authority's DID as the author segment", async () => {
        const prompt = await svc.createPost(input({ authorDid: PLAYER, space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey } }));
        // Never the author's DID (D8): the person stays the out-of-URI facet.
        expect(prompt.space).toEqual(CAMPAIGN);
        expect(prompt.authorDid).toBe(PLAYER);
        expect(buildPostUri(APP, prompt.id, prompt.space)).not.toContain(PLAYER);
    });

    it("uses the authority's DID as the author segment when the author has no DID", async () => {
        const prompt = await svc.createPost(input({ space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey } }));
        expect(prompt.space).toEqual(CAMPAIGN);
    });

    it('keeps placement out of the record CID', async () => {
        await svc.createPost(input({ authorDid: PLAYER, space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey } }));
        const canonical = vi.mocked(deps.cidForRecord).mock.calls[0]![0];
        expect(canonical).not.toHaveProperty('space');
        expect(canonical).not.toHaveProperty('authorSegment');
    });

    it('refuses a prompt naming a malformed space', async () => {
        await expect(svc.createPost(input({ space: { type: 'nope', skey: 'x' } }))).rejects.toMatchObject({ status: 400 });
        expect(deps.savePost).not.toHaveBeenCalled();
    });

    it("creates a reply in its parent's space, with the authority's DID as the author segment", async () => {
        const prompt = await svc.createPost(input({ authorDid: PLAYER, space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey } }));
        const reply = await svc.createPost(
            input({ authorId: 'p2', authorDid: OTHER_PLAYER, text: 'my answer', reply: { root: refTo(prompt), parent: refTo(prompt) } }),
        );
        expect(reply.space).toEqual(CAMPAIGN);
        expect(reply.authorDid).toBe(OTHER_PLAYER);
        // And a reply to that reply stays in the same space.
        const next = await svc.createPost(
            input({ authorId: 'dm', authorDid: PLAYER, text: 'and then', reply: { root: refTo(prompt), parent: refTo(reply) } }),
        );
        expect(next.space).toEqual(CAMPAIGN);
    });

    it('accepts a reply that names its parent’s own space', async () => {
        const prompt = await svc.createPost(input({ authorDid: PLAYER, space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey } }));
        const reply = await svc.createPost(
            input({
                authorId: 'p2',
                text: 'my answer',
                reply: { root: refTo(prompt), parent: refTo(prompt) },
                space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey },
            }),
        );
        expect(reply.space?.skey).toBe(CAMPAIGN.skey);
    });

    it('refuses a reply naming a different space', async () => {
        const prompt = await svc.createPost(input({ authorDid: PLAYER, space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey } }));
        await expect(
            svc.createPost(
                input({
                    authorId: 'p2',
                    text: 'leak',
                    reply: { root: refTo(prompt), parent: refTo(prompt) },
                    space: { type: CAMPAIGN.type, skey: '3kanother2xyz' },
                }),
            ),
        ).rejects.toMatchObject({ status: 400 });
    });

    it('treats a parent uri that names the wrong place as a missing parent', async () => {
        const prompt = await svc.createPost(input({ authorDid: PLAYER, space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey } }));
        const flatRef = { uri: buildPostUri(APP, prompt.id), cid: prompt.cid };
        const wrongSpace = { uri: buildPostUri(APP, prompt.id, { ...CAMPAIGN, skey: '3kanother2xyz' }), cid: prompt.cid };
        // The old rule's uri, with the author's DID as the segment, names nothing.
        const personSegment = { uri: buildPostUri(APP, prompt.id, { ...CAMPAIGN, authorSegment: PLAYER }), cid: prompt.cid };
        for (const parent of [flatRef, wrongSpace, personSegment]) {
            await expect(
                svc.createPost(input({ authorId: 'p2', text: 'x', reply: { root: parent, parent } })),
            ).rejects.toMatchObject({ status: 404 });
        }
    });

    it('hydrates a placed post with its space uri, and looks its transcript up by it', async () => {
        const prompt = await svc.createPost(input({ authorDid: PLAYER, space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey } }));
        const [view] = await svc.hydrateAudioPosts([prompt], null);
        const expected = buildPostUri(APP, prompt.id, CAMPAIGN);
        expect(view?.uri).toBe(expected);
        expect(deps.getTranscriptsBySubjectUris).toHaveBeenCalledWith([{ originAppId: expect.any(String), uri: expected }]);
    });

    it("refuses a prompt in a space the tenant doesn't have", async () => {
        await expect(svc.createPost(input({ space: { type: CAMPAIGN.type, skey: '3knosuch2space' } }))).rejects.toMatchObject({ status: 404 });
        // Another tenant's space by the same key isn't this tenant's.
        deps.spaces.add(`vox-pop/${CAMPAIGN.type}/3kother2space`);
        await expect(svc.createPost(input({ space: { type: CAMPAIGN.type, skey: '3kother2space' } }))).rejects.toMatchObject({ status: 404 });
        expect(deps.savePost).not.toHaveBeenCalled();
    });
});

describe('a reply to a flat post may name a space (cross-repo-design.md §3.2)', () => {
    let deps: ReturnType<typeof makeDeps>;
    let svc: AudioPostService;
    const REPLIES = { type: 'audio.voxpop.space.replies', skey: '3kprompt2abc' };
    const embed = (cid: string) => ({
        $type: 'dev.antiphony.embed.audio' as const,
        audio: { $type: 'blob' as const, ref: { $link: cid }, mimeType: 'audio/webm', size: 10 },
    });
    beforeEach(() => {
        deps = makeDeps();
        deps.spaces.add(`bardcast/${REPLIES.type}/${REPLIES.skey}`);
        deps.blobs.set('bardcast/bafkreplyaudio', REPLIES);
        deps.blobs.set('bardcast/bafkpublic', null);
        svc = new AudioPostService(deps);
    });
    const refTo = (post: AudioPostRecord) => ({ uri: buildPostUri(APP, post.id, post.space), cid: post.cid });
    const replyTo = (root: AudioPostRecord, parent: AudioPostRecord, over: Partial<CreateAudioPostInput> = {}) =>
        input({ authorId: 'p2', text: 'an answer', reply: { root: refTo(root), parent: refTo(parent) }, ...over });

    it('places the reply in the space it names, under the authority as author segment', async () => {
        const prompt = await svc.createPost(input());
        const reply = await svc.createPost(replyTo(prompt, prompt, { authorDid: PLAYER, space: REPLIES, embed: embed('bafkreplyaudio') }));
        expect(prompt.space).toBeUndefined();
        expect(reply.space).toEqual({ ...REPLIES, authorSegment: APP });
        expect(buildPostUri(APP, reply.id, reply.space)).toBe(
            `at://${APP}/space/${REPLIES.type}/${REPLIES.skey}/${APP}/dev.antiphony.audio.post/${reply.id}`,
        );
    });

    it('still makes a flat reply when no space is named', async () => {
        const prompt = await svc.createPost(input());
        const reply = await svc.createPost(replyTo(prompt, prompt));
        expect(reply.space).toBeUndefined();
    });

    it('inherits that space down the branch, and refuses any other there', async () => {
        const prompt = await svc.createPost(input({ authorId: 'creator' }));
        const reply = await svc.createPost(replyTo(prompt, prompt, { space: REPLIES }));
        const back = await svc.createPost(replyTo(prompt, reply, { authorId: 'creator' }));
        expect(back.space).toEqual({ ...REPLIES, authorSegment: APP });
        // Never less restrictive than its parent: not flat, and not elsewhere.
        await expect(
            svc.createPost(replyTo(prompt, reply, { authorId: 'creator', space: { ...REPLIES, skey: '3kother2abc' } })),
        ).rejects.toMatchObject({ status: 400 });
    });

    it("refuses a space the tenant doesn't have (404) or a malformed one (400), saving nothing", async () => {
        const prompt = await svc.createPost(input());
        vi.mocked(deps.savePost).mockClear();
        await expect(svc.createPost(replyTo(prompt, prompt, { space: { ...REPLIES, skey: '3knosuch2space' } }))).rejects.toMatchObject({
            status: 404,
        });
        await expect(svc.createPost(replyTo(prompt, prompt, { space: { type: 'nope', skey: 'x' } }))).rejects.toMatchObject({
            status: 400,
        });
        expect(deps.savePost).not.toHaveBeenCalled();
    });

    it('holds the reply’s audio to the space it names, as for a prompt', async () => {
        const prompt = await svc.createPost(input());
        for (const cid of ['bafkpublic', 'bafkunstored']) {
            await expect(svc.createPost(replyTo(prompt, prompt, { space: REPLIES, embed: embed(cid) }))).rejects.toMatchObject({
                status: 400,
            });
        }
        // And a flat reply can't use audio stored in the space.
        await expect(svc.createPost(replyTo(prompt, prompt, { embed: embed('bafkreplyaudio') }))).rejects.toMatchObject({ status: 400 });
    });
});

describe('reply StrongRef CIDs (cross-repo-design.md §3.4)', () => {
    let deps: ReturnType<typeof makeDeps>;
    let svc: AudioPostService;
    beforeEach(() => {
        deps = makeDeps();
        deps.spaces.add(`bardcast/${CAMPAIGN.type}/${CAMPAIGN.skey}`);
        svc = new AudioPostService(deps);
    });
    const refTo = (post: AudioPostRecord) => ({ uri: buildPostUri(APP, post.id, post.space), cid: post.cid });

    it("refuses a parent CID that isn't the stored record's, with REPLY_CID_MISMATCH", async () => {
        for (const space of [undefined, { type: CAMPAIGN.type, skey: CAMPAIGN.skey }]) {
            const prompt = await svc.createPost(input({ space }));
            const stale = { ...refTo(prompt), cid: 'bafyplaceholder' };
            await expect(
                svc.createPost(input({ authorId: 'p2', text: 'x', reply: { root: refTo(prompt), parent: stale } })),
            ).rejects.toMatchObject({ status: 400, code: 'REPLY_CID_MISMATCH' });
        }
        expect(deps.posts.size).toBe(2); // the two prompts, no reply
    });

    it("refuses a root CID that isn't the root's, on a top-level reply and further down", async () => {
        const prompt = await svc.createPost(input({ authorId: 'creator' }));
        const staleRoot = { ...refTo(prompt), cid: 'bafyplaceholder' };
        await expect(
            svc.createPost(input({ authorId: 'p2', text: 'x', reply: { root: staleRoot, parent: refTo(prompt) } })),
        ).rejects.toMatchObject({ status: 400, code: 'REPLY_CID_MISMATCH' });

        const reply = await svc.createPost(input({ authorId: 'p2', text: 'x', reply: { root: refTo(prompt), parent: refTo(prompt) } }));
        await expect(
            svc.createPost(input({ authorId: 'creator', text: 'y', reply: { root: staleRoot, parent: refTo(reply) } })),
        ).rejects.toMatchObject({ status: 400, code: 'REPLY_CID_MISMATCH' });
        // The real root goes through.
        await expect(
            svc.createPost(input({ authorId: 'creator', text: 'y', reply: { root: refTo(prompt), parent: refTo(reply) } })),
        ).resolves.toMatchObject({ kind: 'reply' });
    });

    it('treats another tenant’s post as missing, even named under the caller’s own authority', async () => {
        // The uri passes the parse-time authority check (it names vox-pop's own
        // DID), so only the store's tenant scoping stands between this reply
        // and bardcast's thread.
        const theirs = await svc.createPost(input({ authorId: 'creator' }));
        const forged = { uri: buildPostUri(appDidFor('vox-pop'), theirs.id), cid: theirs.cid };
        await expect(
            svc.createPost(input({ originAppId: 'vox-pop', authorId: 'p2', text: 'x', reply: { root: forged, parent: forged } })),
        ).rejects.toMatchObject({ status: 404 });
        expect(deps.posts.size).toBe(1);
    });

    it("refuses a root that isn't the thread's root", async () => {
        const prompt = await svc.createPost(input({ authorId: 'creator' }));
        const reply = await svc.createPost(input({ authorId: 'p2', text: 'x', reply: { root: refTo(prompt), parent: refTo(prompt) } }));
        // Naming the parent reply as the root, with its own (correct) CID.
        await expect(
            svc.createPost(input({ authorId: 'creator', text: 'y', reply: { root: refTo(reply), parent: refTo(reply) } })),
        ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    });
});

describe('audio placement (Phase 2)', () => {
    let deps: ReturnType<typeof makeDeps>;
    let svc: AudioPostService;
    const IN_CAMPAIGN = { type: CAMPAIGN.type, skey: CAMPAIGN.skey };
    const embed = (cid: string) => ({
        $type: 'dev.antiphony.embed.audio' as const,
        audio: { $type: 'blob' as const, ref: { $link: cid }, mimeType: 'audio/webm', size: 10 },
    });
    beforeEach(() => {
        deps = makeDeps();
        deps.spaces.add(`bardcast/${CAMPAIGN.type}/${CAMPAIGN.skey}`);
        deps.blobs.set('bardcast/bafkprivate', IN_CAMPAIGN);
        deps.blobs.set('bardcast/bafkpublic', null);
        deps.blobs.set('bardcast/bafkelsewhere', { type: CAMPAIGN.type, skey: '3kanother2xyz' });
        svc = new AudioPostService(deps);
    });

    it('accepts audio uploaded into the post’s own space', async () => {
        const post = await svc.createPost(input({ space: IN_CAMPAIGN, embed: embed('bafkprivate') }));
        expect(post.space?.skey).toBe(CAMPAIGN.skey);
    });

    it('accepts public audio on a flat post, and unknown audio as before', async () => {
        await expect(svc.createPost(input({ embed: embed('bafkpublic') }))).resolves.toBeDefined();
        await expect(svc.createPost(input({ embed: embed('bafkunstored') }))).resolves.toBeDefined();
    });

    it('refuses public, missing or other-space audio on a post in a space', async () => {
        for (const cid of ['bafkpublic', 'bafkunstored', 'bafkelsewhere']) {
            await expect(svc.createPost(input({ space: IN_CAMPAIGN, embed: embed(cid) }))).rejects.toMatchObject({ status: 400 });
        }
    });

    it('refuses private audio on a flat post, so it can never be served unsigned', async () => {
        await expect(svc.createPost(input({ embed: embed('bafkprivate') }))).rejects.toMatchObject({ status: 400 });
        expect(deps.savePost).not.toHaveBeenCalled();
    });

    it('checks a reply’s audio against its parent’s space', async () => {
        const prompt = await svc.createPost(input({ space: IN_CAMPAIGN }));
        const ref = { uri: buildPostUri(APP, prompt.id, prompt.space), cid: prompt.cid };
        await expect(
            svc.createPost(input({ authorId: 'p2', text: 'x', reply: { root: ref, parent: ref }, embed: embed('bafkpublic') })),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            svc.createPost(input({ authorId: 'p2', text: 'x', reply: { root: ref, parent: ref }, embed: embed('bafkprivate') })),
        ).resolves.toMatchObject({ space: { skey: CAMPAIGN.skey } });
    });

    it('asks for a signed URL when hydrating audio in a space', async () => {
        const post = await svc.createPost(input({ space: IN_CAMPAIGN, embed: embed('bafkprivate') }));
        await svc.hydrateAudioPosts([post], null);
        expect(deps.resolveAudioUrl).toHaveBeenCalledWith('bardcast', 'bafkprivate', IN_CAMPAIGN);
        const flat = await svc.createPost(input({ embed: embed('bafkpublic') }));
        await svc.hydrateAudioPosts([flat], null);
        expect(deps.resolveAudioUrl).toHaveBeenLastCalledWith('bardcast', 'bafkpublic', undefined);
    });
});

describe("a member's own record: spaceAuthor 'actor' (audio-service-and-groups.md G5)", () => {
    let deps: ReturnType<typeof makeDeps>;
    let svc: AudioPostService;
    const IN_CAMPAIGN = { type: CAMPAIGN.type, skey: CAMPAIGN.skey };
    beforeEach(() => {
        deps = makeDeps();
        deps.spaces.add(`bardcast/${CAMPAIGN.type}/${CAMPAIGN.skey}`);
        svc = new AudioPostService(deps);
    });
    const refTo = (post: AudioPostRecord) => ({ uri: buildPostUri(APP, post.id, post.space), cid: post.cid });

    it("puts the acting actor's DID in the author segment, under the same authority", async () => {
        const prompt = await svc.createPost(input({ authorDid: PLAYER, space: IN_CAMPAIGN, spaceAuthor: 'actor' }));
        expect(prompt.space).toEqual({ ...IN_CAMPAIGN, authorSegment: PLAYER });
        const uri = buildPostUri(APP, prompt.id, prompt.space);
        expect(uri).toBe(`at://${APP}/space/${CAMPAIGN.type}/${CAMPAIGN.skey}/${PLAYER}/dev.antiphony.audio.post/${prompt.id}`);
        expect(parsePostUri(uri, APP)).toEqual({ authority: APP, id: prompt.id, space: prompt.space });
    });

    it('chooses the author segment per post down a branch, and resolves parents by it', async () => {
        const prompt = await svc.createPost(input({ authorDid: PLAYER, space: IN_CAMPAIGN, spaceAuthor: 'actor' }));
        const reply = await svc.createPost(
            input({ authorId: 'p2', authorDid: OTHER_PLAYER, text: 'my answer', spaceAuthor: 'actor', reply: { root: refTo(prompt), parent: refTo(prompt) } }),
        );
        expect(reply.space).toEqual({ ...IN_CAMPAIGN, authorSegment: OTHER_PLAYER });
        // The authority's own record in the same space, replying to a member's.
        const back = await svc.createPost(
            input({ authorId: 'dm', authorDid: PLAYER, text: 'and then', reply: { root: refTo(prompt), parent: refTo(reply) } }),
        );
        expect(back.space).toEqual(CAMPAIGN);
    });

    it("treats a parent named under someone else's author segment as missing", async () => {
        const prompt = await svc.createPost(input({ authorDid: PLAYER, space: IN_CAMPAIGN, spaceAuthor: 'actor' }));
        const wrong = { uri: buildPostUri(APP, prompt.id, { ...IN_CAMPAIGN, authorSegment: APP }), cid: prompt.cid };
        await expect(
            svc.createPost(input({ authorId: 'p2', authorDid: OTHER_PLAYER, text: 'x', reply: { root: wrong, parent: wrong } })),
        ).rejects.toMatchObject({ status: 404 });
    });

    it('refuses actor authorship on a post that lands flat, saving nothing', async () => {
        await expect(svc.createPost(input({ authorDid: PLAYER, spaceAuthor: 'actor' }))).rejects.toMatchObject({ status: 400 });
        const flat = await svc.createPost(input());
        vi.mocked(deps.savePost).mockClear();
        await expect(
            svc.createPost(input({ authorId: 'p2', authorDid: OTHER_PLAYER, text: 'x', spaceAuthor: 'actor', reply: { root: refTo(flat), parent: refTo(flat) } })),
        ).rejects.toMatchObject({ status: 400 });
        expect(deps.savePost).not.toHaveBeenCalled();
    });

    it('refuses actor authorship without a valid acting actor DID', async () => {
        await expect(svc.createPost(input({ space: IN_CAMPAIGN, spaceAuthor: 'actor' }))).rejects.toMatchObject({ status: 400 });
        await expect(
            svc.createPost(input({ authorDid: 'not-a-did', space: IN_CAMPAIGN, spaceAuthor: 'actor' })),
        ).rejects.toMatchObject({ status: 400 });
        expect(deps.savePost).not.toHaveBeenCalled();
    });

    it("keeps the authority's DID when spaceAuthor is 'authority' or absent", async () => {
        const explicit = await svc.createPost(input({ authorDid: PLAYER, space: IN_CAMPAIGN, spaceAuthor: 'authority' }));
        const omitted = await svc.createPost(input({ authorDid: PLAYER, space: IN_CAMPAIGN }));
        expect(explicit.space).toEqual(CAMPAIGN);
        expect(omitted.space).toEqual(CAMPAIGN);
    });
});

describe('posts under a registered authority (did-plc-and-multi-did-tenancy.md §3)', () => {
    const TABLE = 'did:plc:abcdefghijklmnopqrstuvwx';
    const OTHER = 'did:plc:zyxwvutsrqponmlkjihgfedc';
    const IN_CAMPAIGN = { type: CAMPAIGN.type, skey: CAMPAIGN.skey };
    const REPLIES = { type: 'audio.voxpop.space.replies', skey: '3kprompt2abc' };
    let deps: ReturnType<typeof makeDeps>;
    let svc: AudioPostService;
    beforeEach(() => {
        deps = makeDeps();
        deps.authorities.add(`bardcast/${TABLE}`);
        deps.spaces.add(`bardcast@${TABLE}/${CAMPAIGN.type}/${CAMPAIGN.skey}`);
        deps.spaces.add(`bardcast@${TABLE}/${REPLIES.type}/${REPLIES.skey}`);
        // The same campaign key under the app DID: a different space.
        deps.spaces.add(`bardcast/${CAMPAIGN.type}/${CAMPAIGN.skey}`);
        svc = new AudioPostService(deps);
    });
    const refTo = (post: AudioPostRecord) => ({ uri: buildPostUri(post.authority ?? APP, post.id, post.space), cid: post.cid });

    it("writes a prompt under the named DID, in that DID's space", async () => {
        const prompt = await svc.createPost(input({ authority: TABLE, authorDid: PLAYER, space: IN_CAMPAIGN }));
        expect(prompt.authority).toBe(TABLE);
        // The author segment is the authority's DID, which is now the table's.
        expect(prompt.space).toEqual({ ...IN_CAMPAIGN, authorSegment: TABLE });
        expect(refTo(prompt).uri).toBe(`at://${TABLE}/space/${CAMPAIGN.type}/${CAMPAIGN.skey}/${TABLE}/dev.antiphony.audio.post/${prompt.id}`);
        const [view] = await svc.hydrateAudioPosts([prompt], null);
        expect(view!.uri).toBe(refTo(prompt).uri);
    });

    it("puts a member's own DID in the segment under the group's authority", async () => {
        const prompt = await svc.createPost(input({ authority: TABLE, authorDid: PLAYER, space: IN_CAMPAIGN, spaceAuthor: 'actor' }));
        expect(refTo(prompt).uri).toBe(`at://${TABLE}/space/${CAMPAIGN.type}/${CAMPAIGN.skey}/${PLAYER}/dev.antiphony.audio.post/${prompt.id}`);
    });

    it("refuses an authority the tenant hasn't registered, saving nothing", async () => {
        await expect(svc.createPost(input({ authority: OTHER }))).rejects.toMatchObject({ status: 400, code: 'AUTHORITY_NOT_REGISTERED' });
        await expect(svc.createPost(input({ authority: 'not-a-did' }))).rejects.toMatchObject({ status: 400 });
        expect(deps.savePost).not.toHaveBeenCalled();
    });

    it('stores naming the app DID as naming none', async () => {
        const prompt = await svc.createPost(input({ authority: APP }));
        expect(prompt.authority).toBeUndefined();
        expect(deps.assertWritableAuthority).not.toHaveBeenCalled();
    });

    it("needs the space to exist under the post's own authority", async () => {
        deps.spaces.delete(`bardcast@${TABLE}/${CAMPAIGN.type}/${CAMPAIGN.skey}`);
        // The app DID still has a space by that key, but it's a different space.
        await expect(svc.createPost(input({ authority: TABLE, space: IN_CAMPAIGN }))).rejects.toMatchObject({ status: 404 });
    });

    it("refuses audio stored in the same-named space under another authority", async () => {
        deps.blobs.set('bardcast/bafkappaudio', { ...IN_CAMPAIGN });
        deps.blobs.set('bardcast/bafktableaudio', { ...IN_CAMPAIGN, authority: TABLE });
        const embed = (cid: string) => ({
            $type: 'dev.antiphony.embed.audio' as const,
            audio: { $type: 'blob' as const, ref: { $link: cid }, mimeType: 'audio/webm', size: 10 },
        });
        await expect(svc.createPost(input({ authority: TABLE, space: IN_CAMPAIGN, embed: embed('bafkappaudio') }))).rejects.toMatchObject({
            status: 400,
        });
        await expect(svc.createPost(input({ space: IN_CAMPAIGN, embed: embed('bafktableaudio') }))).rejects.toMatchObject({ status: 400 });
        await expect(svc.createPost(input({ authority: TABLE, space: IN_CAMPAIGN, embed: embed('bafktableaudio') }))).resolves.toBeTruthy();
    });

    it("gives a reply its parent's authority, and refuses naming another", async () => {
        const prompt = await svc.createPost(input({ authority: TABLE, space: IN_CAMPAIGN }));
        const ref = { root: refTo(prompt), parent: refTo(prompt) };
        const reply = await svc.createPost(input({ authorId: 'p2', text: 'an answer', reply: ref }));
        expect(reply.authority).toBe(TABLE);
        expect(reply.space).toEqual({ ...IN_CAMPAIGN, authorSegment: TABLE });
        await expect(svc.createPost(input({ authorId: 'p2', text: 'x', reply: ref, authority: TABLE }))).resolves.toBeTruthy();
        await expect(svc.createPost(input({ authorId: 'p2', text: 'x', reply: ref, authority: APP }))).rejects.toMatchObject({ status: 400 });
        // And down the branch, resolving the parent by its own authority.
        const back = await svc.createPost(input({ authorId: 'dm', text: 'and then', reply: { root: refTo(prompt), parent: refTo(reply) } }));
        expect(back.authority).toBe(TABLE);
    });

    it('treats a parent named under the wrong authority as missing', async () => {
        const prompt = await svc.createPost(input({ authority: TABLE, space: IN_CAMPAIGN }));
        const wrong = { uri: buildPostUri(APP, prompt.id, { ...IN_CAMPAIGN, authorSegment: TABLE }), cid: prompt.cid };
        await expect(svc.createPost(input({ authorId: 'p2', text: 'x', reply: { root: wrong, parent: wrong } }))).rejects.toMatchObject({
            status: 404,
        });
    });

    it("places a flat org prompt's replies in a reply space under the org's DID (Vox Pop)", async () => {
        const prompt = await svc.createPost(input({ authority: TABLE }));
        expect(refTo(prompt).uri).toBe(`at://${TABLE}/dev.antiphony.audio.post/${prompt.id}`);
        const reply = await svc.createPost(
            input({ authorId: 'caller', text: 'a reply', reply: { root: refTo(prompt), parent: refTo(prompt) }, space: REPLIES }),
        );
        expect(refTo(reply).uri).toBe(`at://${TABLE}/space/${REPLIES.type}/${REPLIES.skey}/${TABLE}/dev.antiphony.audio.post/${reply.id}`);
    });
});
