import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

/**
 * What the rate-limit KEY is made of — which is the whole of the 2026-08-21
 * incident, and none of it was visible in a status code.
 *
 * Three independent defects stacked into one symptom (a creator's first prompt
 * of the day returning 429):
 *
 *   1. The client address collapsed to 'unknown' on every request, because this
 *      service became a Cloudflare Worker and the edge sends no
 *      `X-Forwarded-For`. 'unknown' is a real bucket, not a bypass.
 *   2. The key carried no bucket name, so `read` (60/min) and `write` (10 per 15
 *      min) incremented the same counter — browsing spent the ability to post.
 *   3. Writes brokered by a connecting app were keyed by the app's address
 *      rather than by the person writing, so one app's entire user base shared
 *      one allowance.
 *
 * Each is asserted here against the key the store actually receives, because
 * "the request succeeded" is true right up until the shared budget runs out,
 * and by then the cause is a `wrangler tail` away.
 */

const keys: string[] = [];

vi.mock('../composition.js', () => ({
    servicesFor: () => ({
        rateLimitStore: {
            hit: async (key: string) => {
                keys.push(key);
                return 'under' as const;
            },
        },
    }),
}));

vi.mock('../lib/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const VALID_TOKEN = 'a'.repeat(40);

beforeEach(async () => {
    vi.clearAllMocks();
    keys.length = 0;
    process.env.ANTIPHONY_APP_TOKENS = `voxpop:${VALID_TOKEN}`;
    process.env.CLIENT_IP_SOURCE = 'cf';
    const { resetRateLimitCircuitForTest } = await import('./rate-limit.js');
    resetRateLimitCircuitForTest();
});

afterEach(() => {
    delete process.env.CLIENT_IP_SOURCE;
    delete process.env.ANTIPHONY_APP_TOKENS;
});

/**
 * A write route keyed the way the post routes are: aggregate + per-actor.
 *
 * The auth middleware is STUBBED rather than real. `requireAuth()` also runs
 * the tenant-pin gate, which needs a live store this file deliberately does not
 * stand up — and the subject here is what the key is made of, not how the
 * context comes to hold an actor. That `requireAuth()` sets `originAppId` and
 * `viewerUid` from the service token and `X-Antiphony-Acting-Actor` is asserted
 * in `auth.test.ts`; the stub mirrors exactly that assignment, so the two halves
 * meet at a shape both files pin.
 */
async function writeApp() {
    const { rateLimit, RATE_LIMITS } = await import('./rate-limit.js');
    const { ACTING_ACTOR_HEADER } = await import('./auth.js');
    const { matchServiceToken } = await import('./service-auth.js');
    const a = new Hono();
    a.post(
        '/posts',
        async (c, next) => {
            const token = (c.req.header('authorization') ?? '').replace(/^Bearer /, '');
            c.set('originAppId', matchServiceToken(token));
            c.set('viewerUid', c.req.header(ACTING_ACTOR_HEADER)?.trim() || null);
            await next();
        },
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.write, {
            keyBy: (c) => {
                const appId = c.get('originAppId');
                const actor = c.get('viewerUid');
                return appId && actor ? `${appId}:${actor}` : null;
            },
        }),
        (c) => c.json({ ok: true }),
    );
    return a;
}

/** A request as the Vox Pop BFF sends it: service token + asserted actor. */
const asActor = (actor: string, ip = '203.0.113.7') => ({
    method: 'POST',
    headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        'x-antiphony-acting-actor': actor,
        'cf-connecting-ip': ip,
    },
});

describe('rate-limit keying — per acting actor on writes', () => {
    it('gives two users of the same app separate write buckets', async () => {
        const a = await writeApp();
        await a.request('/posts', asActor('user-alice'));
        await a.request('/posts', asActor('user-bob'));

        const writeKeys = keys.filter((k) => k.startsWith('ratelimit_write_'));
        expect(writeKeys).toEqual(['ratelimit_write_voxpop:user-alice', 'ratelimit_write_voxpop:user-bob']);
    });

    it('does not key a write by the calling app address', async () => {
        // The regression. Both users arrive from the same app servers, so an
        // IP-keyed write limit measured the app and throttled its users
        // collectively — 10 prompts per 15 minutes for everybody at once.
        const a = await writeApp();
        await a.request('/posts', asActor('user-alice', '198.51.100.1'));
        await a.request('/posts', asActor('user-bob', '198.51.100.1'));

        expect(keys.filter((k) => k === 'ratelimit_write_198.51.100.1')).toHaveLength(0);
    });

    it('scopes the actor by tenant, so two apps asserting the same id do not collide', async () => {
        process.env.ANTIPHONY_APP_TOKENS = `voxpop:${VALID_TOKEN},otherapp:${'b'.repeat(40)}`;
        const a = await writeApp();
        await a.request('/posts', asActor('user-1'));
        await a.request('/posts', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${'b'.repeat(40)}`,
                'x-antiphony-acting-actor': 'user-1',
                'cf-connecting-ip': '203.0.113.7',
            },
        });

        const writeKeys = keys.filter((k) => k.startsWith('ratelimit_write_'));
        expect(new Set(writeKeys).size).toBe(2);
    });

    it('still applies an IP-keyed aggregate above the actor-keyed limit', async () => {
        // The actor id is app-asserted and therefore unbounded in cardinality:
        // without this, a caller holding a token mints a fresh bucket per
        // request and nothing bounds the total.
        const a = await writeApp();
        await a.request('/posts', asActor('user-alice'));

        expect(keys).toContain('ratelimit_writeAggregate_203.0.113.7');
    });
});

describe('rate-limit keying — presets count independently', () => {
    it('does not let read traffic spend the write allowance', async () => {
        const { rateLimit, RATE_LIMITS } = await import('./rate-limit.js');
        const a = new Hono();
        a.get('/r', rateLimit(RATE_LIMITS.read), (c) => c.json({ ok: true }));
        a.post('/w', rateLimit(RATE_LIMITS.write), (c) => c.json({ ok: true }));

        const headers = { 'cf-connecting-ip': '203.0.113.7' };
        await a.request('/r', { headers });
        await a.request('/w', { method: 'POST', headers });

        expect(keys).toEqual(['ratelimit_read_203.0.113.7', 'ratelimit_write_203.0.113.7']);
        expect(new Set(keys).size).toBe(2);
    });
});

describe('rate-limit keying — the unresolvable-address detector', () => {
    it('warns when the address cannot be resolved, whatever the reason', async () => {
        // Guarded on `ip === 'unknown' && xff` before this change, so a Worker
        // deployment — no XFF at all — silently shared one bucket platform-wide
        // for a day without emitting a line.
        const { logger } = await import('../lib/logger.js');
        const { rateLimit, RATE_LIMITS } = await import('./rate-limit.js');
        const a = new Hono();
        a.get('/r', rateLimit(RATE_LIMITS.read), (c) => c.json({ ok: true }));

        await a.request('/r'); // no CF-Connecting-IP, no XFF

        expect(keys).toEqual(['ratelimit_read_unknown']);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ hasXff: false, hasCfConnectingIp: false }),
            expect.stringContaining('client IP unresolvable'),
        );
    });

    it('stays quiet when the address resolves', async () => {
        const { logger } = await import('../lib/logger.js');
        const { rateLimit, RATE_LIMITS } = await import('./rate-limit.js');
        const a = new Hono();
        a.get('/r', rateLimit(RATE_LIMITS.read), (c) => c.json({ ok: true }));

        await a.request('/r', { headers: { 'cf-connecting-ip': '203.0.113.7' } });

        expect(logger.warn).not.toHaveBeenCalled();
    });
});
