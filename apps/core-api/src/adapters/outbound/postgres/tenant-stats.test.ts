import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { AudioPostRecord } from 'shared/types/audio';
import { TenantStatsService } from '@antiphony/core/services/tenant-stats';
import { createTestDatabase, type TestDatabase } from './testing/pglite.js';
import { postgresAudioPostDependencies } from './audio-posts-dependencies.js';
import { postgresTenantStatsDependencies } from './tenant-stats-dependencies.js';

// `getAppDid` reads the boot-validated pin snapshot, which is not under test.
vi.mock('../../../lib/app-did.js', () => ({
    getAppDid: () => 'did:web:example.com',
}));

/**
 * Tenancy stats (specs/tenancy-stats.md) through the real service and the
 * Postgres binding, against Postgres 18 (PGlite): zeros for a tenant with
 * nothing, tenant isolation, the prompt and reply split, the window edges
 * under an injected clock, and remote posts counted apart from hosted ones.
 */

const TENANT = 'vox-pop';
const NOW = new Date('2026-11-11T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let seq = 0;
const nextId = () => `p${String(++seq).padStart(12, '0')}`;

describe('tenant stats', () => {
    let db: TestDatabase;
    let posts: ReturnType<typeof postgresAudioPostDependencies>;

    beforeAll(async () => {
        db = await createTestDatabase();
        posts = postgresAudioPostDependencies(db, { stat: async () => null });
    });
    afterAll(async () => db.close());
    beforeEach(async () => {
        await db.truncate();
        seq = 0;
    });

    const stats = (originAppId = TENANT, now = NOW) =>
        new TenantStatsService(postgresTenantStatsDependencies(db), () => now).getStats(originAppId);

    /** A hosted post: a reply when `reply` is set. */
    function addPost(over: { originAppId?: string; reply?: boolean; createdAt?: Date } = {}) {
        const id = nextId();
        const base = {
            id,
            cid: `bafyreicid${id}`,
            originAppId: over.originAppId ?? TENANT,
            authorId: 'user-1',
            text: 'hello',
            createdAt: over.createdAt ?? ago(HOUR),
        };
        const record = over.reply
            ? {
                  ...base,
                  kind: 'reply',
                  rootAuthorId: 'user-root',
                  reply: {
                      root: { uri: 'at://did:web:example.com/c/root', cid: 'bafyreiroot' },
                      parent: { uri: 'at://did:web:example.com/c/parent', cid: 'bafyreiparent' },
                  },
              }
            : { ...base, kind: 'prompt' };
        return posts.savePost(record as AudioPostRecord);
    }

    /** A registered remote post, a reply when it names a root. */
    function addRemote(over: { originAppId?: string; reply?: boolean; createdAt?: Date } = {}) {
        const id = nextId();
        const createdAt = over.createdAt ?? ago(HOUR);
        const record = {
            $type: 'dev.antiphony.audio.post',
            text: 'hi',
            createdAt: createdAt.toISOString(),
            ...(over.reply
                ? { reply: { root: { uri: 'at://did:plc:abc/c/root', cid: 'bafyreiroot' }, parent: { uri: 'at://did:plc:abc/c/root', cid: 'bafyreiroot' } } }
                : {}),
        };
        return db.query(
            `insert into remote_posts (origin_app_id, uri, cid, repo_did, collection, rkey, record,
                                       blob_cid, mime_type, size, created_at)
             values ($1, $2, 'bafyreirecord', 'did:plc:abcdefghijklmnopqrstuvwx', 'dev.antiphony.audio.post', $3,
                     $4::jsonb, 'bafkreiblob', 'audio/mp4', 10, $5)`,
            [over.originAppId ?? TENANT, `at://did:plc:abcdefghijklmnopqrstuvwx/dev.antiphony.audio.post/${id}`, id, JSON.stringify(record), createdAt],
        );
    }

    const zero = { posts: 0, prompts: 0, replies: 0 };

    it('answers zeros for a tenant with nothing, and says when it read', async () => {
        const result = await stats('tenant-with-nothing');
        expect(result).toEqual({
            posts: { totals: zero, windows: { last24h: zero, last7d: zero } },
            remotePosts: { totals: zero, windows: { last24h: zero, last7d: zero } },
            asOf: '2026-11-11T12:00:00.000Z',
        });
    });

    it('counts only the calling tenant, hosted and remote', async () => {
        await addPost();
        await addPost({ reply: true });
        await addRemote();
        await addPost({ originAppId: 'other-app' });
        await addPost({ originAppId: 'other-app', reply: true });
        await addRemote({ originAppId: 'other-app' });
        await addRemote({ originAppId: 'other-app', reply: true });

        const mine = await stats();
        expect(mine.posts.totals).toEqual({ posts: 2, prompts: 1, replies: 1 });
        expect(mine.remotePosts.totals).toEqual({ posts: 1, prompts: 1, replies: 0 });

        const theirs = await stats('other-app');
        expect(theirs.posts.totals).toEqual({ posts: 2, prompts: 1, replies: 1 });
        expect(theirs.remotePosts.totals).toEqual({ posts: 2, prompts: 1, replies: 1 });
    });

    it('splits prompts from replies in the totals and in both windows', async () => {
        await addPost({ createdAt: ago(2 * HOUR) });
        await addPost({ reply: true, createdAt: ago(3 * HOUR) });
        await addPost({ reply: true, createdAt: ago(4 * HOUR) });
        await addPost({ createdAt: ago(3 * DAY) });
        await addPost({ reply: true, createdAt: ago(5 * DAY) });
        await addPost({ createdAt: ago(40 * DAY) });
        await addPost({ reply: true, createdAt: ago(40 * DAY) });

        const { posts } = await stats();
        expect(posts.totals).toEqual({ posts: 7, prompts: 3, replies: 4 });
        expect(posts.windows.last24h).toEqual({ posts: 3, prompts: 1, replies: 2 });
        expect(posts.windows.last7d).toEqual({ posts: 5, prompts: 2, replies: 3 });
    });

    it('puts a row exactly on a window edge inside it, and one a millisecond older outside', async () => {
        await addPost({ createdAt: ago(DAY) });
        await addPost({ createdAt: ago(DAY + 1) });
        await addPost({ reply: true, createdAt: ago(7 * DAY) });
        await addPost({ reply: true, createdAt: ago(7 * DAY + 1) });
        await addRemote({ createdAt: ago(DAY) });
        await addRemote({ createdAt: ago(DAY + 1) });
        await addRemote({ reply: true, createdAt: ago(7 * DAY) });
        await addRemote({ reply: true, createdAt: ago(7 * DAY + 1) });

        const { posts, remotePosts } = await stats();
        expect(posts.windows.last24h).toEqual({ posts: 1, prompts: 1, replies: 0 });
        expect(posts.windows.last7d).toEqual({ posts: 3, prompts: 2, replies: 1 });
        expect(posts.totals.posts).toBe(4);
        expect(remotePosts.windows.last24h).toEqual({ posts: 1, prompts: 1, replies: 0 });
        expect(remotePosts.windows.last7d).toEqual({ posts: 3, prompts: 2, replies: 1 });
        expect(remotePosts.totals.posts).toBe(4);
    });

    it('moves the windows with the clock it is given', async () => {
        await addPost({ createdAt: ago(HOUR) });

        expect((await stats(TENANT, NOW)).posts.windows.last24h.posts).toBe(1);
        // A day and an hour later the post has left the 24 hour window but not the 7 day one.
        const later = new Date(NOW.getTime() + DAY + 2 * HOUR);
        const result = await stats(TENANT, later);
        expect(result.posts.windows.last24h.posts).toBe(0);
        expect(result.posts.windows.last7d.posts).toBe(1);
        expect(result.asOf).toBe(later.toISOString());
    });

    it('counts remote posts apart from hosted ones, by reply root', async () => {
        await addPost();
        await addRemote();
        await addRemote({ reply: true });
        await addRemote({ reply: true, createdAt: ago(10 * DAY) });

        const result = await stats();
        expect(result.posts.totals).toEqual({ posts: 1, prompts: 1, replies: 0 });
        expect(result.remotePosts.totals).toEqual({ posts: 3, prompts: 1, replies: 2 });
        expect(result.remotePosts.windows.last24h).toEqual({ posts: 2, prompts: 1, replies: 1 });
        expect(result.remotePosts.windows.last7d).toEqual({ posts: 2, prompts: 1, replies: 1 });
    });

    it('keeps prompts + replies = posts in every figure', async () => {
        for (let i = 0; i < 6; i++) {
            await addPost({ reply: i % 2 === 0, createdAt: ago(i * 2 * DAY) });
            await addRemote({ reply: i % 3 === 0, createdAt: ago(i * 2 * DAY) });
        }
        const result = await stats();
        for (const side of [result.posts, result.remotePosts]) {
            for (const c of [side.totals, side.windows.last24h, side.windows.last7d]) {
                expect(c.prompts + c.replies).toBe(c.posts);
            }
        }
    });
});
