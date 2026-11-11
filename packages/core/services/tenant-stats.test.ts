import { describe, it, expect, vi } from 'vitest';
import type { PostStats } from 'shared/types/stats';
import { TenantStatsService } from './tenant-stats';
import type { StatsWindowEdges, TenantStatsDependencies } from '../ports/tenant-stats-dependencies';

/** A row as the fake stores it: whose it is, which table, whether it replies, and when it was made. */
interface FakeRow {
    originAppId: string;
    table: 'posts' | 'remotePosts';
    reply: boolean;
    createdAt: Date;
}

const counts = (rows: FakeRow[]) => ({
    posts: rows.length,
    prompts: rows.filter((r) => !r.reply).length,
    replies: rows.filter((r) => r.reply).length,
});

/** An in-memory port that counts the way the Postgres binding must. */
function fakeDeps(rows: FakeRow[]): TenantStatsDependencies & { calls: Array<[string, StatsWindowEdges]> } {
    const calls: Array<[string, StatsWindowEdges]> = [];
    const statsOf = (own: FakeRow[], edges: StatsWindowEdges): PostStats => ({
        totals: counts(own),
        windows: {
            last24h: counts(own.filter((r) => r.createdAt >= edges.since24h)),
            last7d: counts(own.filter((r) => r.createdAt >= edges.since7d)),
        },
    });
    return {
        calls,
        countTenantPosts: vi.fn(async (originAppId, edges) => {
            calls.push([originAppId, edges]);
            const own = rows.filter((r) => r.originAppId === originAppId);
            return {
                posts: statsOf(own.filter((r) => r.table === 'posts'), edges),
                remotePosts: statsOf(own.filter((r) => r.table === 'remotePosts'), edges),
            };
        }),
    };
}

const NOW = new Date('2026-11-11T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;
const row = (over: Partial<FakeRow>): FakeRow => ({
    originAppId: 'vox-pop',
    table: 'posts',
    reply: false,
    createdAt: ago(HOUR),
    ...over,
});

describe('TenantStatsService', () => {
    it('reports the clock it read once as asOf, and derives both window edges from it', async () => {
        const deps = fakeDeps([]);
        const clock = vi.fn(() => NOW);
        const stats = await new TenantStatsService(deps, clock).getStats('vox-pop');

        expect(clock).toHaveBeenCalledTimes(1);
        expect(stats.asOf).toBe('2026-11-11T12:00:00.000Z');
        expect(deps.calls).toEqual([
            ['vox-pop', { since24h: new Date('2026-11-10T12:00:00.000Z'), since7d: new Date('2026-11-04T12:00:00.000Z') }],
        ]);
    });

    it('answers zeros, not an error, for a tenant with nothing', async () => {
        const zero = { posts: 0, prompts: 0, replies: 0 };
        const none = { totals: zero, windows: { last24h: zero, last7d: zero } };
        expect(await new TenantStatsService(fakeDeps([]), () => NOW).getStats('vox-pop')).toEqual({
            posts: none,
            remotePosts: none,
            asOf: NOW.toISOString(),
        });
    });

    it('splits prompts from replies, windows from totals, and hosted from remote', async () => {
        const deps = fakeDeps([
            row({}),
            row({ reply: true }),
            row({ reply: true, createdAt: ago(3 * 24 * HOUR) }),
            row({ createdAt: ago(30 * 24 * HOUR) }),
            row({ table: 'remotePosts', reply: true, createdAt: ago(2 * HOUR) }),
            row({ originAppId: 'someone-else' }),
        ]);
        const stats = await new TenantStatsService(deps, () => NOW).getStats('vox-pop');

        expect(stats.posts).toEqual({
            totals: { posts: 4, prompts: 2, replies: 2 },
            windows: {
                last24h: { posts: 2, prompts: 1, replies: 1 },
                last7d: { posts: 3, prompts: 1, replies: 2 },
            },
        });
        expect(stats.remotePosts.totals).toEqual({ posts: 1, prompts: 0, replies: 1 });
        expect(stats.remotePosts.windows.last24h).toEqual({ posts: 1, prompts: 0, replies: 1 });
    });
});
