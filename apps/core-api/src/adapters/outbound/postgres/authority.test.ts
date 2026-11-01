import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/pglite.js';
import { postgresAudioPostDependencies } from './audio-posts-dependencies.js';
import { postgresSpaceDependencies } from './space-dependencies.js';
import { postgresDidRegistryDependencies } from './did-registry-dependencies.js';
import { writableAuthorityCheck } from './writable-authority.js';
import { resetDidCustodyCache } from '../../../lib/app-did.js';
import type { AudioPostRecord } from 'shared/types/audio';

vi.mock('../../../lib/app-did.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../lib/app-did.js')>()),
    getAppDid: () => 'did:web:bardcast.example',
}));

/**
 * Migration 0005 (posts and spaces under a registered DID) against real
 * Postgres 18 (PGlite): the foreign keys that keep an authority to a DID its
 * tenant registered, spaces keyed by authority, unregistering refused while
 * anything is under a DID, and the write-path check.
 */

const APP = 'did:web:bardcast.example';
const TABLE = 'did:plc:abcdefghijklmnopqrstuvwx';
const CAMPAIGN = { type: 'game.bardcast.space.campaign', skey: 'thornwood' };

function post(over: Partial<AudioPostRecord> = {}): AudioPostRecord {
    return {
        id: '3kpost1aaaaaa',
        cid: 'bafyreiaaa',
        originAppId: 'bardcast',
        authorId: 'dm',
        kind: 'prompt',
        text: 'the scene',
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
        ...over,
    } as AudioPostRecord;
}

describe('authority (migration 0005)', () => {
    let db: TestDatabase;
    let posts: ReturnType<typeof postgresAudioPostDependencies>;
    let spaces: ReturnType<typeof postgresSpaceDependencies>;
    let registry: ReturnType<typeof postgresDidRegistryDependencies>;

    beforeAll(async () => {
        db = await createTestDatabase();
        const allowAll = async () => undefined;
        spaces = postgresSpaceDependencies(db, allowAll);
        posts = postgresAudioPostDependencies(db, { stat: async () => null });
        registry = postgresDidRegistryDependencies(db);
    });
    afterAll(async () => db.close());
    beforeEach(async () => db.truncate());

    const register = (originAppId = 'bardcast') => registry.insertTenantDid({ did: TABLE, originAppId, role: 'group' });
    const putSpace = (authority?: string) =>
        spaces.putSpace({
            originAppId: 'bardcast',
            key: { ...CAMPAIGN, ...(authority ? { authority } : {}) },
            readPolicy: 'managing-app',
            writePolicy: 'managing-app',
        });

    it("keeps the app DID's space and a group's same-named space apart", async () => {
        await register();
        await putSpace();
        await putSpace(TABLE);
        expect(await spaces.getSpace('bardcast', CAMPAIGN)).toMatchObject({ ...CAMPAIGN });
        expect((await spaces.getSpace('bardcast', CAMPAIGN))?.authority).toBeUndefined();
        expect(await spaces.getSpace('bardcast', { ...CAMPAIGN, authority: TABLE })).toMatchObject({ authority: TABLE });
        expect(await spaces.deleteSpace('bardcast', { ...CAMPAIGN, authority: TABLE })).toBe('deleted');
        expect(await spaces.getSpace('bardcast', CAMPAIGN)).not.toBeNull();
    });

    it("refuses a space under a DID its tenant hasn't registered, or another tenant has", async () => {
        await expect(putSpace(TABLE)).rejects.toThrow(/spaces_authority_registered/);
        await register('voxpop');
        await expect(putSpace(TABLE)).rejects.toThrow(/spaces_authority_registered/);
    });

    it('round-trips a post under a registered DID, and refuses one under an unregistered DID', async () => {
        await expect(posts.savePost(post({ authority: TABLE }))).rejects.toThrow(/posts_authority_registered/);
        await register();
        await posts.savePost(post({ authority: TABLE }));
        expect((await posts.getPostById('bardcast', '3kpost1aaaaaa'))?.authority).toBe(TABLE);
    });

    it("needs a placed post's space under the post's own authority", async () => {
        await register();
        await putSpace(); // only the app DID's
        const placed = post({ authority: TABLE, space: { ...CAMPAIGN, authorSegment: TABLE } });
        await expect(posts.savePost(placed)).rejects.toThrow(/posts_space_exists/);
        await putSpace(TABLE);
        await posts.savePost(placed);
        // And the space can't be deleted while it holds the post.
        expect(await spaces.deleteSpace('bardcast', { ...CAMPAIGN, authority: TABLE })).toBe('not-empty');
        expect(await spaces.deleteSpace('bardcast', CAMPAIGN)).toBe('deleted');
    });

    it('refuses to unregister a DID while a post or a space is under it', async () => {
        await register();
        await posts.savePost(post({ authority: TABLE }));
        expect(await registry.deleteTenantDid('bardcast', TABLE)).toBe('in-use');
        await db.query(`delete from posts`);

        await putSpace(TABLE);
        expect(await registry.deleteTenantDid('bardcast', TABLE)).toBe('in-use');
        await spaces.deleteSpace('bardcast', { ...CAMPAIGN, authority: TABLE });

        expect(await registry.deleteTenantDid('voxpop', TABLE)).toBe('absent');
        expect(await registry.deleteTenantDid('bardcast', TABLE)).toBe('deleted');
        expect(await registry.deleteTenantDid('bardcast', TABLE)).toBe('absent');
    });

    describe('the write-path check', () => {
        beforeEach(() => resetDidCustodyCache());
        const doc = (host: string) =>
            (async () =>
                new Response(
                    JSON.stringify({ id: TABLE, service: [{ id: '#atproto_space_host', serviceEndpoint: `https://${host}` }] }),
                )) as unknown as typeof fetch;

        it('passes a DID registered to this tenant whose document names this deployment', async () => {
            await register();
            const check = writableAuthorityCheck(db, { expectedPdsHost: 'core.antiphony.dev', fetchImpl: doc('core.antiphony.dev') });
            await expect(check('bardcast', TABLE)).resolves.toBeUndefined();
        });

        it("refuses one this tenant hasn't registered (400), before resolving anything", async () => {
            await register('voxpop');
            const fetchImpl = vi.fn(doc('core.antiphony.dev'));
            const check = writableAuthorityCheck(db, { expectedPdsHost: 'core.antiphony.dev', fetchImpl });
            await expect(check('bardcast', TABLE)).rejects.toMatchObject({ status: 400, code: 'AUTHORITY_NOT_REGISTERED' });
            expect(fetchImpl).not.toHaveBeenCalled();
        });

        it('refuses a registered DID whose document moved elsewhere (503)', async () => {
            await register();
            const check = writableAuthorityCheck(db, { expectedPdsHost: 'core.antiphony.dev', fetchImpl: doc('elsewhere.example') });
            await expect(check('bardcast', TABLE)).rejects.toMatchObject({ status: 503, code: 'AUTHORITY_CUSTODY_UNPROVEN' });
        });

        it('refuses everything on a deployment with no host to check against', async () => {
            await register();
            const check = writableAuthorityCheck(db, { fetchImpl: doc('elsewhere.example') });
            await expect(check('bardcast', TABLE)).rejects.toMatchObject({ code: 'AUTHORITY_CUSTODY_UNPROVEN' });
        });

        it('caches a proof, so a second write within the hour resolves nothing', async () => {
            await register();
            const fetchImpl = vi.fn(doc('core.antiphony.dev'));
            const check = writableAuthorityCheck(db, { expectedPdsHost: 'core.antiphony.dev', fetchImpl });
            await check('bardcast', TABLE);
            await check('bardcast', TABLE);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        });
    });

    it('keeps APP out of every column: the app DID is never stored', async () => {
        await putSpace();
        await posts.savePost(post({ space: { ...CAMPAIGN, authorSegment: APP } }));
        const [space] = await db.query<{ authority: string; authority_did: string | null }>(`select authority, authority_did from spaces`);
        const [row] = await db.query<{ authority: string | null; space_authority: string }>(`select authority, space_authority from posts`);
        expect(space).toEqual({ authority: '', authority_did: null });
        expect(row).toEqual({ authority: null, space_authority: '' });
    });
});
