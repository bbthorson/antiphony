import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/pglite.js';
import { postgresAudioPostDependencies } from './audio-posts-dependencies.js';
import { postgresSpaceDependencies } from './space-dependencies.js';
import type { AudioPostRecord } from 'shared/types/audio';

vi.mock('../../../lib/app-did.js', () => ({
    getAppDid: () => 'did:web:bardcast.example',
}));

/**
 * Migration 0002 (atproto spaces, Phase 1) against real Postgres 18 (PGlite):
 * a post's placement round-trips through the record, the database refuses a
 * half-placed post or one whose space doesn't exist, and a space that still
 * holds posts can't be deleted.
 */

const SPACE = { type: 'game.bardcast.space.campaign', skey: '3kcampaign2abc', authorSegment: 'did:plc:abc123player' };

function post(over: Partial<AudioPostRecord> = {}): AudioPostRecord {
    return {
        id: '3kpost1aaaaaa',
        cid: 'bafyreiaaa',
        originAppId: 'bardcast',
        authorId: 'dm',
        kind: 'prompt',
        text: 'the scene',
        createdAt: new Date('2026-10-07T00:00:00.000Z'),
        ...over,
    } as AudioPostRecord;
}

describe('spaces (migration 0002)', () => {
    let db: TestDatabase;
    let deps: ReturnType<typeof postgresAudioPostDependencies>;

    beforeAll(async () => {
        db = await createTestDatabase();
        deps = postgresAudioPostDependencies(db, { stat: async () => null });
    });
    afterAll(async () => db.close());
    beforeEach(async () => db.truncate());

    const createSpace = (originAppId = 'bardcast', skey = SPACE.skey) =>
        db.query(
            `insert into spaces (origin_app_id, space_type, skey, read_policy, write_policy)
             values ($1, $2, $3, 'managing-app', 'managing-app')`,
            [originAppId, SPACE.type, skey],
        );

    it('defaults both policies to member-list, and refuses an unknown policy', async () => {
        await db.query(`insert into spaces (origin_app_id, space_type, skey) values ('bardcast', $1, 'k1')`, [SPACE.type]);
        const [row] = await db.query<{ read_policy: string; write_policy: string }>(
            `select read_policy, write_policy from spaces where skey = 'k1'`,
        );
        expect(row).toEqual({ read_policy: 'member-list', write_policy: 'member-list' });
        await expect(
            db.query(`insert into spaces (origin_app_id, space_type, skey, read_policy) values ('bardcast', $1, 'k2', 'secret')`, [SPACE.type]),
        ).rejects.toThrow(/spaces_read_policy_valid/);
    });

    it('round-trips a placed post and promotes its placement to columns', async () => {
        await createSpace();
        await deps.savePost(post({ space: SPACE }));
        expect((await deps.getPostById('bardcast', '3kpost1aaaaaa'))?.space).toEqual(SPACE);
        const [row] = await db.query<{ space_type: string; skey: string; author_segment: string }>(
            `select space_type, skey, author_segment from posts where id = '3kpost1aaaaaa'`,
        );
        expect(row).toEqual({ space_type: SPACE.type, skey: SPACE.skey, author_segment: SPACE.authorSegment });
    });

    it('leaves a flat post with no placement', async () => {
        await deps.savePost(post());
        expect((await deps.getPostById('bardcast', '3kpost1aaaaaa'))?.space).toBeUndefined();
    });

    it("refuses a post in a space that doesn't exist, or exists for another tenant", async () => {
        await expect(deps.savePost(post({ space: SPACE }))).rejects.toThrow(/posts_space_exists/);
        await createSpace('vox-pop');
        await expect(deps.savePost(post({ space: SPACE }))).rejects.toThrow(/posts_space_exists/);
    });

    it('refuses a half-placed post, even written around the schema', async () => {
        await createSpace();
        const halfPlaced = { ...post(), space: { type: SPACE.type, skey: SPACE.skey } };
        await expect(
            db.query(
                `insert into posts (id, origin_app_id, record, created_at) values ($1, 'bardcast', $2::jsonb, $3)`,
                ['3kpost2aaaaaa', JSON.stringify(halfPlaced), '2026-10-07T00:00:00.000Z'],
            ),
        ).rejects.toThrow(/posts_space_all_or_none/);
    });

    it('refuses to delete a space that still holds posts', async () => {
        await createSpace();
        await deps.savePost(post({ space: SPACE }));
        await expect(db.query(`delete from spaces where skey = $1`, [SPACE.skey])).rejects.toThrow(/posts_space_exists/);
    });

    describe('the spaces adapter', () => {
        const KEY = { type: SPACE.type, skey: SPACE.skey };

        it('upserts: a replace keeps createdAt, moves updatedAt, and clears an omitted endpoint', async () => {
            const spaces = postgresSpaceDependencies(db);
            const first = await spaces.putSpace({
                originAppId: 'bardcast',
                key: KEY,
                readPolicy: 'managing-app',
                writePolicy: 'managing-app',
                managingAppEndpoint: 'https://bardcast.example/access',
            });
            expect(first).toMatchObject({ readPolicy: 'managing-app', managingAppEndpoint: 'https://bardcast.example/access' });
            const second = await spaces.putSpace({ originAppId: 'bardcast', key: KEY, readPolicy: 'member-list', writePolicy: 'member-list' });
            expect(second.createdAt).toEqual(first.createdAt);
            expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
            expect(second.managingAppEndpoint).toBeUndefined();
            expect(await spaces.getSpace('bardcast', KEY)).toEqual(second);
            expect(await spaces.getSpace('vox-pop', KEY)).toBeNull();
        });
    });

    describe('playback for audio in a space', () => {
        const META = { 'antiphony-space': `${SPACE.type}/${SPACE.skey}` };

        it("reads a blob's space from its object metadata", async () => {
            const stat = vi.fn(async (path: string) => (path.endsWith('bafkreiprivate') ? { metadata: META } : path.endsWith('bafkreipublic') ? {} : null));
            const withStorage = postgresAudioPostDependencies(db, { stat });
            expect(await withStorage.getBlobSpace('bardcast', 'bafkreiprivate')).toEqual({ space: { type: SPACE.type, skey: SPACE.skey } });
            expect(await withStorage.getBlobSpace('bardcast', 'bafkreipublic')).toEqual({ space: null });
            expect(await withStorage.getBlobSpace('bardcast', 'bafkreimissing')).toBeNull();
            expect(stat).toHaveBeenCalledWith('blobs/bardcast/bafkreiprivate');
        });

        it('signs the url for a spaced post, and gives none when it cannot sign', async () => {
            const priorBase = process.env.ANTIPHONY_PUBLIC_BASE_URL;
            process.env.ANTIPHONY_PUBLIC_BASE_URL = 'https://api.antiphony.test';
            try {
                expect(await deps.resolveAudioUrl('bardcast', 'bafkreiaudio', { type: SPACE.type, skey: SPACE.skey })).toBeNull();
                process.env.ANTIPHONY_PLAYBACK_SECRET = 'test-playback-secret-0123456789abcdef';
                const url = await deps.resolveAudioUrl('bardcast', 'bafkreiaudio', { type: SPACE.type, skey: SPACE.skey });
                expect(url).toMatch(/^https:\/\/api\.antiphony\.test\/api\/v1\/audio\?url=blobs%2Fbardcast%2Fbafkreiaudio&exp=\d+&sig=[A-Za-z0-9_-]+$/);
                expect(await deps.resolveAudioUrl('bardcast', 'bafkreiaudio')).toBe(
                    'https://api.antiphony.test/api/v1/audio?url=blobs%2Fbardcast%2Fbafkreiaudio',
                );
            } finally {
                delete process.env.ANTIPHONY_PLAYBACK_SECRET;
                if (priorBase === undefined) delete process.env.ANTIPHONY_PUBLIC_BASE_URL;
                else process.env.ANTIPHONY_PUBLIC_BASE_URL = priorBase;
            }
        });
    });
});
