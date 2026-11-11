import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantStats } from 'shared/types/stats';

/**
 * Route test for the XRPC query `dev.antiphony.tenant.getStats`. The service is
 * mocked; this covers the adapter's part: the credential, no acting actor, the
 * bare body, and the XRPC error dialect. Counting is in the Postgres suite.
 */

const zero = { posts: 0, prompts: 0, replies: 0 };
const STATS: TenantStats = {
    posts: {
        totals: { posts: 4182, prompts: 1204, replies: 2978 },
        windows: {
            last24h: { posts: 37, prompts: 4, replies: 33 },
            last7d: { posts: 291, prompts: 26, replies: 265 },
        },
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
const STATS_PATH = '/xrpc/dev.antiphony.tenant.getStats';
const get = (headers: Record<string, string> = auth) => app().request(STATS_PATH, { headers });

beforeEach(() => {
    tenantStatsService.getStats.mockReset();
    tenantStatsService.getStats.mockResolvedValue(STATS);
});

describe('dev.antiphony.tenant.getStats', () => {
    it('needs a service token, and answers in the XRPC dialect without one', async () => {
        const res = await get({});
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'AuthenticationRequired' });
        expect(tenantStatsService.getStats).not.toHaveBeenCalled();
    });

    it('answers the bare body, for the tenant the token names, with no acting actor', async () => {
        const res = await get();

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual(STATS);
        // Not the REST envelope.
        expect(body).not.toHaveProperty('success');
        expect(tenantStatsService.getStats).toHaveBeenCalledWith('test-app');
    });

    it('ignores an acting actor rather than refusing it', async () => {
        const res = await get({ ...auth, 'x-antiphony-acting-actor': 'someone' });
        expect(res.status).toBe(200);
        expect(tenantStatsService.getStats).toHaveBeenCalledWith('test-app');
    });

    it('takes no parameters: anything in the query string is not passed on', async () => {
        const res = await app().request(`${STATS_PATH}?originAppId=another-app&from=2026-01-01`, { headers: auth });
        expect(res.status).toBe(200);
        expect(tenantStatsService.getStats).toHaveBeenCalledWith('test-app');
    });
});
