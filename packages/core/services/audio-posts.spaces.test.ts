import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    AudioPostService,
    buildPostUri,
    buildRecordUri,
    parsePostId,
    parsePostUri,
    type CreateAudioPostInput,
} from './audio-posts';
import type { AudioPostDependencies } from '../ports/audio-posts-dependencies';
import type { AudioPostRecord, TranscriptEnrichmentRecord } from 'shared/types/audio';
import type { SpaceKey, SpacePlacement } from 'shared/types/spaces';

/**
 * atproto spaces, Phase 1 (specs/spaces.md): space-aware post URIs, and
 * placement through `createPost` and hydration. Flat behaviour is covered by
 * audio-posts.test.ts and must not change.
 */

const APP = 'did:web:bardcast.example';
const appDidFor = (originAppId: string) => (originAppId === 'bardcast' ? APP : `did:web:${originAppId}.example`);
const PLAYER = 'did:plc:abc123player';
const OTHER_PLAYER = 'did:plc:xyz789other';
const CAMPAIGN: SpacePlacement = { type: 'game.bardcast.space.campaign', skey: '3kcampaign2abc', authorSegment: PLAYER };

describe('space post URIs', () => {
    it('builds the space shape through @atproto/syntax', () => {
        expect(buildPostUri(APP, '3kabc2def3ghi', CAMPAIGN)).toBe(
            `at://${APP}/space/game.bardcast.space.campaign/3kcampaign2abc/${PLAYER}/dev.antiphony.audio.post/3kabc2def3ghi`,
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
        expect(parsePostUri(uri, APP)).toEqual({ id: '3kabc2def3ghi', space: CAMPAIGN });
        expect(parsePostId(uri, APP)).toBe('3kabc2def3ghi');
    });

    it('accepts a DID as the space key (a per-player space)', () => {
        const mine: SpacePlacement = { type: 'game.bardcast.space.player', skey: PLAYER, authorSegment: PLAYER };
        const uri = buildPostUri(APP, '3kabc2def3ghi', mine);
        expect(parsePostUri(uri, APP)).toEqual({ id: '3kabc2def3ghi', space: mine });
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

/** In-memory dependencies that store posts, spaces and blob placements. */
function makeDeps(): AudioPostDependencies & {
    posts: Map<string, AudioPostRecord>;
    spaces: Set<string>;
    blobs: Map<string, SpaceKey | null>;
} {
    let counter = 0;
    const posts = new Map<string, AudioPostRecord>();
    const spaces = new Set<string>();
    const blobs = new Map<string, SpaceKey | null>();
    const keyOf = (originAppId: string, k: SpaceKey) => `${originAppId}/${k.type}/${k.skey}`;
    return {
        posts,
        spaces,
        blobs,
        getSpace: vi.fn(async (originAppId: string, k: SpaceKey) =>
            spaces.has(keyOf(originAppId, k))
                ? ({ originAppId, ...k, readPolicy: 'managing-app', writePolicy: 'managing-app', createdAt: new Date(), updatedAt: new Date() } as const)
                : null,
        ),
        getBlobSpace: vi.fn(async (originAppId: string, cid: string) => {
            const key = `${originAppId}/${cid}`;
            return blobs.has(key) ? { space: blobs.get(key) ?? null } : null;
        }),
        newPostId: vi.fn(() => `3kpost${++counter}aaaaa`),
        getAppDid: vi.fn(appDidFor),
        savePost: vi.fn(async (r: AudioPostRecord) => { posts.set(`${r.originAppId}/${r.id}`, r); }),
        getPostById: vi.fn(async (originAppId: string, id: string) => posts.get(`${originAppId}/${id}`) ?? null),
        queryByAuthor: vi.fn(async () => []),
        queryByRootAuthor: vi.fn(async () => []),
        queryReplies: vi.fn(async () => []),
        getTranscriptsBySubjectUris: vi.fn(async () => new Map<string, TranscriptEnrichmentRecord>()),
        resolveAudioUrl: vi.fn(async () => 'https://audio.example/x'),
        cidForRecord: vi.fn(async () => 'bafyreitestcid'),
        now: vi.fn(() => new Date('2026-10-07T00:00:00Z')),
    } as unknown as AudioPostDependencies & {
        posts: Map<string, AudioPostRecord>;
        spaces: Set<string>;
        blobs: Map<string, SpaceKey | null>;
    };
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

    it('places a prompt in the space it names, with the author DID as the author segment', async () => {
        const prompt = await svc.createPost(input({ authorDid: PLAYER, space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey } }));
        expect(prompt.space).toEqual(CAMPAIGN);
    });

    it("uses the tenant's app DID as the author segment when the author has no DID", async () => {
        const prompt = await svc.createPost(input({ space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey } }));
        expect(prompt.space).toEqual({ ...CAMPAIGN, authorSegment: APP });
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

    it("creates a reply in its parent's space, with the replier's DID as the author segment", async () => {
        const prompt = await svc.createPost(input({ authorDid: PLAYER, space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey } }));
        const reply = await svc.createPost(
            input({ authorId: 'p2', authorDid: OTHER_PLAYER, text: 'my answer', reply: { root: refTo(prompt), parent: refTo(prompt) } }),
        );
        expect(reply.space).toEqual({ ...CAMPAIGN, authorSegment: OTHER_PLAYER });
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

    it('refuses a reply to a flat post that names a space', async () => {
        const flat = await svc.createPost(input());
        await expect(
            svc.createPost(
                input({ authorId: 'p2', text: 'x', reply: { root: refTo(flat), parent: refTo(flat) }, space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey } }),
            ),
        ).rejects.toMatchObject({ status: 400 });
    });

    it('treats a parent uri that names the wrong place as a missing parent', async () => {
        const prompt = await svc.createPost(input({ authorDid: PLAYER, space: { type: CAMPAIGN.type, skey: CAMPAIGN.skey } }));
        const flatRef = { uri: buildPostUri(APP, prompt.id), cid: prompt.cid };
        const wrongSpace = { uri: buildPostUri(APP, prompt.id, { ...CAMPAIGN, skey: '3kanother2xyz' }), cid: prompt.cid };
        for (const parent of [flatRef, wrongSpace]) {
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
        expect(deps.getTranscriptsBySubjectUris).toHaveBeenCalledWith([expected]);
    });

    it("refuses a prompt in a space the tenant doesn't have", async () => {
        await expect(svc.createPost(input({ space: { type: CAMPAIGN.type, skey: '3knosuch2space' } }))).rejects.toMatchObject({ status: 404 });
        // Another tenant's space by the same key isn't this tenant's.
        deps.spaces.add(`vox-pop/${CAMPAIGN.type}/3kother2space`);
        await expect(svc.createPost(input({ space: { type: CAMPAIGN.type, skey: '3kother2space' } }))).rejects.toMatchObject({ status: 404 });
        expect(deps.savePost).not.toHaveBeenCalled();
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
