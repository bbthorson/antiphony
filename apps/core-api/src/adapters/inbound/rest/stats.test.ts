import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantStats } from 'shared/types/stats';

/**
 * Route test for `GET /api/v1/stats`, the REST twin of
 * `dev.antiphony.tenant.getStats`: the credential, no acting actor, and the
 * envelope. The service is mocked; counting is in the Postgres suite.
 */

const zero = { posts: 0, prompts: 0, replies: 0 };
const STATS: TenantStats = {
    posts: {
        totals: { posts: 3, prompts: 1, replies: 2 },
        windows: { last24h: { posts: 1, prompts: 0, replies: 1 }, last7d: { posts: 2, prompts: 1, replies: 1 } },
    },
    remotePosts: { totals: zero, windows: { last24h: zero, last7d: zero } },
    asOf: '2026-11-11T14:02:11.000Z',
};

const tenantStatsService = { getStats: vi.fn() };

vi.mock('../../../composition.js', () => ({
    servicesFor: () => ({
        tenantStatsService,
        rateLimitStore: { hit: async () => 'under' as const },
    }),
}));

const SERVICE_TOKEN = 'svc-tok-abcdefghijklmnopqrstuvwxyz012345';
process.env.LOG_LEVEL = 'silent';
process.env.ANTIPHONY_APP_TOKENS = `test-app:${SERVICE_TOKEN}`;

const { app } = await import('../../../app.js');
const { seedValidatedPins } = await import('../../../lib/testing/seed-pins.js');
await seedValidatedPins({ 'test-app': 'did:web:test-app.example' });

const auth = { authorization: `Bearer ${SERVICE_TOKEN}` };

beforeEach(() => {
    tenantStatsService.getStats.mockReset();
    tenantStatsService.getStats.mockResolvedValue(STATS);
});

describe('GET /api/v1/stats', () => {
    it('refuses an unauthenticated call, in the REST envelope', async () => {
        const res = await app().request('/api/v1/stats');
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ success: false });
        expect(tenantStatsService.getStats).not.toHaveBeenCalled();
    });

    it('answers the same body as the XRPC query, inside the envelope, with no acting actor', async () => {
        const res = await app().request('/api/v1/stats', { headers: auth });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, data: STATS });
        expect(tenantStatsService.getStats).toHaveBeenCalledWith('test-app');
    });

    it('ignores an acting actor rather than refusing it', async () => {
        const res = await app().request('/api/v1/stats', { headers: { ...auth, 'x-antiphony-acting-actor': 'someone' } });
        expect(res.status).toBe(200);
        expect(tenantStatsService.getStats).toHaveBeenCalledWith('test-app');
    });
});
