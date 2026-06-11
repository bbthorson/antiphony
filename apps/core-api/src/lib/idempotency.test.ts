import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

/** Mirror of the (private) docId derivation in idempotency.ts. */
function expectedDocId(uid: string, key: string): string {
    return `${uid}_${createHash('sha256').update(key).digest('hex')}`;
}

/**
 * Unit tests for `checkIdempotency` / `saveIdempotencyResult`.
 *
 * The critical property under test (M5 security fix): two different callers
 * sending the *same* raw Idempotency-Key must get independent Firestore
 * documents so that user A's cached response is never returned to user B.
 */

// ---------------------------------------------------------------------------
// Firestore mock — records which doc IDs were read/written so tests can assert
// on them.
// ---------------------------------------------------------------------------

type DocStub = { get: () => Promise<{ exists: boolean; data: () => undefined }>; set: (data: unknown, opts?: unknown) => void };
const docSpy = vi.fn<(id: string) => DocStub>();

vi.mock('./firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: (_name: string) => ({
            doc: (id: string) => docSpy(id),
        }),
        runTransaction: async (fn: (t: unknown) => Promise<unknown>) => {
            // During the transaction, delegate to the doc spy so we can
            // inspect which document ID was used.
            const txGet = async () => ({ exists: false, data: () => undefined });
            const txSet = vi.fn();
            // Call fn with a fake transaction object that resolves with "new key"
            return fn({ get: txGet, set: txSet });
        },
    }),
    getAdmin: () => ({
        firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TS' }, Timestamp: { fromMillis: (ms: number) => ({ _ms: ms }) } },
    }),
}));

// We also need the real admin FieldValue used inside checkIdempotency. The
// firebase-admin import is resolved via the mock above.

process.env.LOG_LEVEL = 'silent';

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

const { checkIdempotency, saveIdempotencyResult } = await import('./idempotency.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Hono-compatible context with a given idempotency header. */
function makeCtx(uid: string, idempotencyKey: string | null) {
    return {
        req: {
            header: (name: string) => (name === 'idempotency-key' ? idempotencyKey : null),
        },
        get: (key: string) => (key === 'requestId' ? 'test-req' : undefined),
    } as unknown as Parameters<typeof checkIdempotency>[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkIdempotency / saveIdempotencyResult — per-user namespacing (M5)', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        // Default: doc spy returns a "get" that resolves with no existing doc
        docSpy.mockReturnValue({
            get: async () => ({ exists: false, data: () => undefined }),
            set: vi.fn(),
        });
    });

    it('returns null when no Idempotency-Key header is present', async () => {
        const ctx = makeCtx('uid-a', null);
        const result = await checkIdempotency(ctx, 'uid-a');
        expect(result).toBeNull();
    });

    it('uses a doc ID prefixed by the uid (not the raw key)', async () => {
        // We spy on runTransaction indirectly: the transaction callback
        // receives a `t.get(docRef)` call. We capture the docRef by
        // intercepting getAdminDb().collection().doc().

        // Capture the doc ID passed to the second collection().doc() call
        // (the first is the transaction itself).
        const capturedDocIds: string[] = [];
        docSpy.mockImplementation((id: string) => {
            capturedDocIds.push(id);
            return {
                get: async () => ({ exists: false, data: () => undefined }),
                set: vi.fn(),
            };
        });

        const ctx = makeCtx('user-alpha', 'my-key-123');

        // Trigger the transaction path by re-wiring getAdminDb to capture the
        // doc ID before the transaction runs.
        // The function under test calls:
        //   db.collection(COLLECTION).doc(docId(uid, key))
        // and then `db.runTransaction(async t => { const doc = await t.get(docRef) … })`.
        // Our mock simply calls the fn synchronously — we verify the ID via docSpy.
        await checkIdempotency(ctx, 'user-alpha');

        // At least one call should have the uid_ prefix.
        expect(capturedDocIds.some((id) => id.startsWith('user-alpha_'))).toBe(true);
        expect(capturedDocIds.some((id) => id === 'my-key-123')).toBe(false);
    });

    it('uses DIFFERENT doc IDs for two users with the SAME raw key (cross-user isolation)', async () => {
        const capturedDocIds: string[] = [];
        docSpy.mockImplementation((id: string) => {
            capturedDocIds.push(id);
            return {
                get: async () => ({ exists: false, data: () => undefined }),
                set: vi.fn(),
            };
        });

        const key = 'shared-key';

        const ctxA = makeCtx('user-A', key);
        const ctxB = makeCtx('user-B', key);

        await checkIdempotency(ctxA, 'user-A');
        await checkIdempotency(ctxB, 'user-B');

        const idsForA = capturedDocIds.filter((id) => id.startsWith('user-A_'));
        const idsForB = capturedDocIds.filter((id) => id.startsWith('user-B_'));

        // Both users hit a doc prefixed by their own uid.
        expect(idsForA.length).toBeGreaterThan(0);
        expect(idsForB.length).toBeGreaterThan(0);

        // The doc IDs are DIFFERENT — no cross-user collision.
        expect(idsForA[0]).not.toBe(idsForB[0]);
        expect(idsForA[0]).toBe(expectedDocId('user-A', key));
        expect(idsForB[0]).toBe(expectedDocId('user-B', key));
    });

    it('produces a path-safe doc ID when the key contains "/" (no subcollection)', async () => {
        const capturedDocIds: string[] = [];
        docSpy.mockImplementation((id: string) => {
            capturedDocIds.push(id);
            return {
                get: async () => ({ exists: false, data: () => undefined }),
                set: vi.fn(),
            };
        });

        // A `/` in the raw key would otherwise make Firestore treat the doc ID
        // as a subcollection path. Hashing keeps every doc ID flat + path-safe.
        const ctx = makeCtx('user-slash', 'some/evil/../key');
        await checkIdempotency(ctx, 'user-slash');

        expect(capturedDocIds.length).toBeGreaterThan(0);
        for (const id of capturedDocIds) {
            expect(id).not.toContain('/');
            expect(id).toBe(expectedDocId('user-slash', 'some/evil/../key'));
        }
    });

    it('saveIdempotencyResult also uses the uid-prefixed doc ID', async () => {
        const capturedDocIds: string[] = [];
        docSpy.mockImplementation((id: string) => {
            capturedDocIds.push(id);
            return {
                get: async () => ({ exists: false, data: () => undefined }),
                set: vi.fn(),
            };
        });

        const ctx = makeCtx('user-save', 'save-key');
        await saveIdempotencyResult(ctx, 'user-save', { success: true, data: { promptId: 'p-1' } });

        expect(capturedDocIds.some((id) => id === expectedDocId('user-save', 'save-key'))).toBe(true);
        expect(capturedDocIds.some((id) => id === 'save-key')).toBe(false);
    });
});
