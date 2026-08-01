import { describe, it, expect, vi } from 'vitest';

/**
 * `checkRateLimit` — the Firestore-backed counter behind both the `rateLimit`
 * middleware and `POST /api/v1/system/rate-limit/check`.
 *
 * Worth testing directly, and previously untested, because its failure handling
 * is deliberately ASYMMETRIC and easy to invert:
 *
 *   - Per-bucket transaction contention (ABORTED / FAILED_PRECONDITION) fails
 *     **closed** — many concurrent writers on one bucket is the thing a rate
 *     limit exists to catch — and must NOT feed the circuit breaker. If it did,
 *     one caller hammering their own bucket could trip the breaker and
 *     fail-open rate limiting for everybody.
 *   - A systemic Firestore failure fails **open**, so an outage degrades rate
 *     limiting instead of taking the whole API down, and DOES feed the breaker.
 *
 * Swap those two and the bug is invisible in normal operation — it only shows
 * up under the exact load the limiter is supposed to handle.
 *
 * The breaker is module-scoped state that persists across calls within an
 * instance, so every test re-imports the module for a clean counter.
 */

/** The fake Firestore for the current test; read lazily so it can be swapped mid-test. */
let db: unknown;

vi.mock('../lib/firebase-admin.js', () => ({
    getAdminDb: () => db,
    getAdmin: () => ({
        firestore: { Timestamp: { fromMillis: (ms: number) => ({ ms }) } },
    }),
}));

// Silence the module's logging; these tests assert behavior, not log lines.
vi.mock('../lib/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface Bucket {
    count: number;
    resetTime: number;
}

interface FakeTx {
    get: (ref: unknown) => Promise<{ exists: boolean; data: () => Bucket | undefined }>;
    set: (ref: unknown, value: Record<string, unknown>) => void;
    update: (ref: unknown, value: Record<string, unknown>) => void;
}

/**
 * A Firestore stand-in that runs the real transaction body against a chosen
 * stored bucket, or throws a grpc-shaped error with the given `code`.
 */
function fakeDb(opts: { bucket?: Bucket; throwCode?: number | string } = {}) {
    const writes: { set?: Record<string, unknown>; update?: Record<string, unknown> } = {};
    let transactions = 0;
    const docRef = {};

    return {
        writes,
        /** How many times the transaction was actually attempted — 0 proves the breaker short-circuited. */
        get transactions() {
            return transactions;
        },
        handle: {
            collection: () => ({ doc: () => docRef }),
            runTransaction: async (fn: (t: FakeTx) => Promise<boolean>) => {
                transactions++;
                if (opts.throwCode !== undefined) {
                    const err = new Error('firestore') as Error & { code?: number | string };
                    err.code = opts.throwCode;
                    throw err;
                }
                return fn({
                    get: async () => ({
                        exists: opts.bucket !== undefined,
                        data: () => opts.bucket,
                    }),
                    set: (_ref, value) => {
                        writes.set = value;
                    },
                    update: (_ref, value) => {
                        writes.update = value;
                    },
                });
            },
        },
    };
}

/** Re-import for a clean circuit-breaker counter (module-scoped by design). */
async function freshCheckRateLimit() {
    vi.resetModules();
    const mod = await import('./rate-limit.js');
    return mod.checkRateLimit;
}

const LIMIT = { limit: 10, windowMs: 60_000 };

describe('checkRateLimit — counting', () => {
    it('creates the bucket and allows when no document exists', async () => {
        const check = await freshCheckRateLimit();
        const fake = fakeDb({});
        db = fake.handle;

        await expect(check('ratelimit_1.2.3.4', LIMIT)).resolves.toEqual({ allowed: true });
        expect(fake.writes.set).toMatchObject({ count: 1 });
        expect(fake.writes.update).toBeUndefined();
    });

    it('resets the window rather than incrementing once resetTime has passed', async () => {
        const check = await freshCheckRateLimit();
        // Well over the limit, but the window already closed.
        const fake = fakeDb({ bucket: { count: 99, resetTime: Date.now() - 1_000 } });
        db = fake.handle;

        await expect(check('k', LIMIT)).resolves.toEqual({ allowed: true });
        expect(fake.writes.set).toMatchObject({ count: 1 });
    });

    it('increments and allows while under the limit', async () => {
        const check = await freshCheckRateLimit();
        const fake = fakeDb({ bucket: { count: 3, resetTime: Date.now() + 30_000 } });
        db = fake.handle;

        await expect(check('k', LIMIT)).resolves.toEqual({ allowed: true });
        expect(fake.writes.update).toEqual({ count: 4 });
    });

    it('blocks once the count has reached the limit, without writing', async () => {
        const check = await freshCheckRateLimit();
        const fake = fakeDb({ bucket: { count: 10, resetTime: Date.now() + 30_000 } });
        db = fake.handle;

        await expect(check('k', LIMIT)).resolves.toEqual({ allowed: false });
        expect(fake.writes.set).toBeUndefined();
        expect(fake.writes.update).toBeUndefined();
    });
});

describe('checkRateLimit — failure asymmetry', () => {
    // Both the numeric grpc codes and their string names, since the module
    // checks structurally rather than importing the Admin SDK's error types.
    it.each([10, 'ABORTED', 9, 'FAILED_PRECONDITION'])(
        'fails CLOSED on per-bucket contention (code %s)',
        async (code) => {
            const check = await freshCheckRateLimit();
            db = fakeDb({ throwCode: code }).handle;

            await expect(check('k', LIMIT)).resolves.toEqual({ allowed: false });
        },
    );

    it.each([14, 'UNAVAILABLE', 4, 13])(
        'fails OPEN on a systemic Firestore error (code %s)',
        async (code) => {
            const check = await freshCheckRateLimit();
            db = fakeDb({ throwCode: code }).handle;

            await expect(check('k', LIMIT)).resolves.toEqual({ allowed: true });
        },
    );
});

describe('checkRateLimit — circuit breaker', () => {
    it('opens after 5 systemic failures and then allows without querying Firestore', async () => {
        const check = await freshCheckRateLimit();
        db = fakeDb({ throwCode: 14 }).handle;
        for (let i = 0; i < 5; i++) {
            await expect(check('k', LIMIT)).resolves.toEqual({ allowed: true });
        }

        // A bucket that WOULD block. The breaker should answer before we reach it.
        const blocked = fakeDb({ bucket: { count: 999, resetTime: Date.now() + 30_000 } });
        db = blocked.handle;

        await expect(check('k', LIMIT)).resolves.toEqual({ allowed: true });
        expect(blocked.transactions).toBe(0);
    });

    it('does NOT let bucket contention trip the breaker', async () => {
        const check = await freshCheckRateLimit();
        // Far more contention errors than the systemic threshold.
        db = fakeDb({ throwCode: 'ABORTED' }).handle;
        for (let i = 0; i < 10; i++) {
            await expect(check('hot-bucket', LIMIT)).resolves.toEqual({ allowed: false });
        }

        // If contention had counted toward the breaker it would now be open, and
        // this over-limit bucket would be waved through unqueried — which is the
        // bypass the asymmetry exists to prevent.
        const blocked = fakeDb({ bucket: { count: 999, resetTime: Date.now() + 30_000 } });
        db = blocked.handle;

        await expect(check('k', LIMIT)).resolves.toEqual({ allowed: false });
        expect(blocked.transactions).toBe(1);
    });

    it('resets the failure count after a success, so blips do not accumulate into an open circuit', async () => {
        const check = await freshCheckRateLimit();

        db = fakeDb({ throwCode: 14 }).handle;
        for (let i = 0; i < 4; i++) await check('k', LIMIT);

        // One success clears the counter.
        db = fakeDb({ bucket: { count: 1, resetTime: Date.now() + 30_000 } }).handle;
        await expect(check('k', LIMIT)).resolves.toEqual({ allowed: true });

        // Four more failures must therefore still be below the threshold.
        db = fakeDb({ throwCode: 14 }).handle;
        for (let i = 0; i < 4; i++) await check('k', LIMIT);

        const blocked = fakeDb({ bucket: { count: 999, resetTime: Date.now() + 30_000 } });
        db = blocked.handle;
        await expect(check('k', LIMIT)).resolves.toEqual({ allowed: false });
        expect(blocked.transactions).toBe(1);
    });
});
