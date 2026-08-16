import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/pglite.js';
import { postgresRateLimitStore } from './rate-limit-store.js';
import type { RateLimitStore } from '../../../ports/rate-limit-store.js';

/**
 * Postgres `RateLimitStore` against real Postgres 18 (PGlite, in-process).
 *
 * The Firestore binding's suite has to simulate gRPC transaction conflicts to
 * reach its interesting branches. This one does not have those branches — the
 * whole check is one upsert — so what is worth testing here is different: that
 * the window arithmetic is right, that the counter is atomic, and that the
 * limit boundary is where the contract says it is.
 */

describe('postgresRateLimitStore', () => {
    let db: TestDatabase;
    let store: RateLimitStore;

    beforeAll(async () => {
        db = await createTestDatabase();
        store = postgresRateLimitStore(db);
    });
    afterAll(async () => db.close());
    beforeEach(async () => db.truncate());

    const WINDOW = { limit: 3, windowMs: 60_000 };

    it('allows up to the limit and refuses beyond it', async () => {
        // Post-increment semantics: hits 1..3 are the three the limit permits.
        expect(await store.hit('ip-a', WINDOW)).toBe('under');
        expect(await store.hit('ip-a', WINDOW)).toBe('under');
        expect(await store.hit('ip-a', WINDOW)).toBe('under');
        // The 4th exceeds a limit of 3 — off-by-one here would silently grant
        // every caller one extra request, which no smoke test would notice.
        expect(await store.hit('ip-a', WINDOW)).toBe('over');
    });

    it('keys buckets independently', async () => {
        for (let n = 0; n < 4; n++) await store.hit('ip-a', WINDOW);
        expect(await store.hit('ip-b', WINDOW)).toBe('under');
    });

    it('starts a fresh window once the old one closes', async () => {
        await store.hit('ip-a', WINDOW);
        await store.hit('ip-a', WINDOW);
        await store.hit('ip-a', WINDOW);
        expect(await store.hit('ip-a', WINDOW)).toBe('over');

        // Age the bucket past its window rather than sleeping — the binding
        // reads `reset_time` from the row, so moving the row is equivalent and
        // keeps the suite instant.
        await db.query(`update rate_limits set reset_time = now() - interval '1 second'`);

        expect(await store.hit('ip-a', WINDOW)).toBe('under');
        const [row] = await db.query<{ count: number }>('select count from rate_limits');
        expect(Number(row.count)).toBe(1);
    });

    it('counts concurrent hits exactly once each', async () => {
        // The property the whole design rests on. A read-then-write would lose
        // increments here; a single upsert cannot.
        const wide = { limit: 1000, windowMs: 60_000 };
        await Promise.all(Array.from({ length: 50 }, () => store.hit('burst', wide)));

        const [row] = await db.query<{ count: number }>(
            'select count from rate_limits where key = $1',
            ['burst'],
        );
        expect(Number(row.count)).toBe(50);
    });

    it('reports `unavailable` rather than throwing when the query fails', async () => {
        // The contract's hard requirement: the caller's circuit breaker needs a
        // value, not an exception. Simulated by pointing the store at a client
        // whose query always rejects.
        const broken = postgresRateLimitStore({
            async query() {
                throw new Error('connection terminated');
            },
        });
        await expect(broken.hit('ip-a', WINDOW)).resolves.toBe('unavailable');
    });

    it('stamps expires_at beyond the window so the sweep cannot reclaim a live bucket', async () => {
        await store.hit('ip-a', WINDOW);
        const [row] = await db.query<{ ok: boolean }>(
            'select (expires_at > reset_time) as ok from rate_limits where key = $1',
            ['ip-a'],
        );
        expect(row.ok).toBe(true);
    });
});
