import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * The service-caller exemption on `rateLimit(...)`.
 *
 * What makes this worth its own file: the exemption is a BYPASS, and the two
 * ways it can be wrong are opposite and both silent.
 *
 *   - Too narrow (a valid token still limited) and the failure it exists to fix
 *     comes back — a sibling service's whole traffic in one IP bucket.
 *   - Too broad (exemption applied where it was not asked for, or an invalid
 *     token honoured) and rate limiting quietly disappears from routes that
 *     still need it. Every route behind `requireServiceToken()` is reached only
 *     by authenticated callers, so a blanket exemption would delete the write
 *     limit without any test noticing.
 *
 * So both directions are asserted, and the store is a spy: "was the limiter
 * consulted at all" is the actual question, not the status code.
 */

/** The port is `hit(key, window)`, and it COUNTS the hit as part of answering. */
const hit = vi.fn(async () => 'under' as const);

vi.mock('../composition.js', () => ({
    servicesFor: () => ({ rateLimitStore: { hit } }),
}));

vi.mock('../lib/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const VALID_TOKEN = 'a'.repeat(40);

beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ANTIPHONY_APP_TOKENS = `voxpop:${VALID_TOKEN}`;
    const { resetRateLimitCircuitForTest } = await import('./rate-limit.js');
    resetRateLimitCircuitForTest();
});

async function appWith(exempt: boolean) {
    const { rateLimit, RATE_LIMITS } = await import('./rate-limit.js');
    const a = new Hono();
    a.get(
        '/audio',
        rateLimit(RATE_LIMITS.read, exempt ? { exemptServiceCallers: true } : {}),
        (c) => c.json({ ok: true }),
    );
    return a;
}

describe('rateLimit — exemptServiceCallers', () => {
    it('does not consult the limiter for a valid service token', async () => {
        const a = await appWith(true);
        const res = await a.request('/audio', {
            headers: { authorization: `Bearer ${VALID_TOKEN}` },
        });

        expect(res.status).toBe(200);
        expect(hit).not.toHaveBeenCalled();
    });

    it('still limits an anonymous caller on the same route', async () => {
        const a = await appWith(true);
        const res = await a.request('/audio');

        expect(res.status).toBe(200);
        // The point: Twilio and every browser still land here. The exemption
        // must not turn the route into an unlimited one.
        expect(hit).toHaveBeenCalledTimes(1);
    });

    it('still limits a caller presenting an UNRECOGNISED token', async () => {
        const a = await appWith(true);
        const res = await a.request('/audio', {
            headers: { authorization: `Bearer ${'b'.repeat(40)}` },
        });

        expect(res.status).toBe(200);
        expect(hit).toHaveBeenCalledTimes(1);
    });

    it('still limits when the header is malformed rather than absent', async () => {
        const a = await appWith(true);
        await a.request('/audio', { headers: { authorization: VALID_TOKEN } });

        // No `Bearer ` prefix — the right token in the wrong shape is not a
        // credential, and must not be treated as one.
        expect(hit).toHaveBeenCalledTimes(1);
    });

    it('limits a valid service token when the route did NOT opt in', async () => {
        const a = await appWith(false);
        await a.request('/audio', { headers: { authorization: `Bearer ${VALID_TOKEN}` } });

        // This is what keeps the write limit alive on routes behind
        // requireServiceToken(), where every caller is authenticated.
        expect(hit).toHaveBeenCalledTimes(1);
    });
});
