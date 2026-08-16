import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/pglite.js';
import { postgresIdempotencyStore } from './idempotency-store.js';
import type { IdempotencyStore } from '../../../ports/idempotency-store.js';

/**
 * Postgres `IdempotencyStore` against real Postgres 18 (PGlite, in-process).
 *
 * The four-branch Firestore transaction collapses to one upsert here, and the
 * mechanism it leans on — a skipped `DO UPDATE` returning no row — is subtle
 * enough that it is the thing most worth pinning with real SQL. A mock would
 * have happily confirmed whatever behaviour I assumed.
 */

const TTL = 24 * 60 * 60 * 1000;

describe('postgresIdempotencyStore', () => {
    let db: TestDatabase;
    let store: IdempotencyStore;

    beforeAll(async () => {
        db = await createTestDatabase();
        store = postgresIdempotencyStore(db);
    });
    afterAll(async () => db.close());
    beforeEach(async () => db.truncate());

    it('claims an absent key', async () => {
        await expect(store.claim('k1', TTL)).resolves.toBe('claimed');
    });

    it('reports a second claim on a live key as in-progress', async () => {
        await store.claim('k1', TTL);
        await expect(store.claim('k1', TTL)).resolves.toBe('in-progress');
    });

    it('replays a settled response', async () => {
        await store.claim('k1', TTL);
        await store.settle('k1', { id: 'post-1', ok: true }, TTL);
        await expect(store.claim('k1', TTL)).resolves.toEqual({
            replay: { id: 'post-1', ok: true },
        });
    });

    it('reclaims an expired key as if absent', async () => {
        await store.claim('k1', TTL);
        await store.settle('k1', { id: 'stale' }, TTL);
        // Age it past expiry. The port contract says expired is
        // indistinguishable from absent — the caller must never see the stale
        // response, and must not be told the key existed.
        await db.query(`update idempotency_keys set expires_at = now() - interval '1 second'`);

        await expect(store.claim('k1', TTL)).resolves.toBe('claimed');
        // And the reclaim must have wiped the old response, or a later
        // in-flight collision could replay a body from a previous request.
        const [row] = await db.query<{ status: string; response: unknown }>(
            'select status, response from idempotency_keys where id = $1',
            ['k1'],
        );
        expect(row.status).toBe('processing');
        expect(row.response).toBeNull();
    });

    it('grants exactly one claim under concurrency', async () => {
        // The guarantee the port exists for. A read-then-write would let two
        // requests both see "absent" and both proceed, duplicating a write the
        // client asked to happen once.
        const results = await Promise.all(
            Array.from({ length: 25 }, () => store.claim('same-key', TTL)),
        );
        expect(results.filter((r) => r === 'claimed')).toHaveLength(1);
        expect(results.filter((r) => r === 'in-progress')).toHaveLength(24);
    });

    it('round-trips a null response body', async () => {
        // `settle(…, undefined)` serialises to JSON null rather than SQL NULL;
        // getting this wrong makes the replay branch indistinguishable from a
        // never-settled key.
        await store.claim('k1', TTL);
        await store.settle('k1', null, TTL);
        await expect(store.claim('k1', TTL)).resolves.toEqual({ replay: null });
    });

    it('does not throw when settle fails', async () => {
        // Best-effort by contract: the work already succeeded, so a storage
        // failure here must not surface. Losing the replay costs a duplicate
        // execution on retry, which is strictly better than failing a write
        // that already happened.
        const broken = postgresIdempotencyStore({
            async query() {
                throw new Error('connection terminated');
            },
        });
        await expect(broken.settle('k1', { ok: true }, TTL)).resolves.toBeUndefined();
    });
});
