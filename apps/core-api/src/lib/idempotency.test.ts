import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
    checkIdempotency,
    saveIdempotencyResult,
    IdempotencyInProgressError,
} from './idempotency.js';
import type { IdempotencyStore, IdempotencyClaim } from '../ports/idempotency-store.js';

/**
 * `checkIdempotency` / `saveIdempotencyResult` — the HTTP-contract half of
 * idempotency: read the header, derive a per-caller id from it, apply the TTL.
 *
 * The critical property (M5 security fix): two different callers sending the
 * *same* raw `Idempotency-Key` must get independent records, so user A's cached
 * response is never returned to user B.
 *
 * ## These tests used to mock Firestore to observe the id
 *
 * The derivation was asserted by mocking `lib/firebase-admin.js` and capturing
 * the string passed to `collection().doc()` — reaching through the store to see
 * a value the store is merely handed. That worked, but it read the id out of
 * the wrong layer, and it needed `native.js` imported for the whole module
 * graph just to have a store composed at all.
 *
 * Both functions take an optional `store`, which is the seam this actually
 * wants: a fake `IdempotencyStore` records the ids it is given directly. No
 * composition root, no Firestore, and the assertions now name the thing under
 * test. `adapters/outbound/postgres/idempotency-store.test.ts` owns the
 * storage side, including `claim`'s atomicity.
 */

/** Mirror of the (private) id derivation in idempotency.ts. */
function expectedId(uid: string, key: string): string {
    return `${uid}_${createHash('sha256').update(key).digest('hex')}`;
}

/** A store that records every id it is asked about and answers as directed. */
function recordingStore(claim: IdempotencyClaim = 'claimed') {
    const claimed: string[] = [];
    const settled: { id: string; response: unknown }[] = [];
    const store: IdempotencyStore = {
        async claim(id) {
            claimed.push(id);
            return claim;
        },
        async settle(id, response) {
            settled.push({ id, response });
        },
    };
    return { store, claimed, settled };
}

/** A minimal Hono-compatible context carrying the given header. */
function makeCtx(idempotencyKey: string | null) {
    return {
        req: {
            header: (name: string) => (name === 'idempotency-key' ? idempotencyKey : null),
        },
        get: (key: string) => (key === 'requestId' ? 'test-req' : undefined),
        env: undefined,
    } as unknown as Parameters<typeof checkIdempotency>[0];
}

describe('checkIdempotency — per-user namespacing (M5)', () => {
    it('returns null and touches no store when the header is absent', async () => {
        const { store, claimed } = recordingStore();
        expect(await checkIdempotency(makeCtx(null), 'uid-a', store)).toBeNull();
        expect(claimed).toEqual([]);
    });

    it('treats a whitespace-only header as absent', async () => {
        const { store, claimed } = recordingStore();
        expect(await checkIdempotency(makeCtx('   '), 'uid-a', store)).toBeNull();
        expect(claimed).toEqual([]);
    });

    it('claims an id prefixed by the uid, never the raw key', async () => {
        const { store, claimed } = recordingStore();
        await checkIdempotency(makeCtx('my-key-123'), 'user-alpha', store);

        expect(claimed).toEqual([expectedId('user-alpha', 'my-key-123')]);
        expect(claimed).not.toContain('my-key-123');
    });

    it('derives DIFFERENT ids for two users sending the SAME raw key', async () => {
        // The isolation property itself. Without it, the first caller's cached
        // response could be replayed to a second (resource-id leak), or a
        // second could pre-register a key and force a spurious 409 for the
        // first (write denial).
        const key = 'shared-key';
        const a = recordingStore();
        const b = recordingStore();

        await checkIdempotency(makeCtx(key), 'user-A', a.store);
        await checkIdempotency(makeCtx(key), 'user-B', b.store);

        expect(a.claimed[0]).toBe(expectedId('user-A', key));
        expect(b.claimed[0]).toBe(expectedId('user-B', key));
        expect(a.claimed[0]).not.toBe(b.claimed[0]);
    });

    it('produces a path-safe id when the key contains "/" or ".."', async () => {
        // A client-supplied key can contain anything. Firestore read `/` as a
        // path separator and `.`/`..` as reserved ids; Postgres has no such
        // rule, but the id is still a primary key built from hostile input, so
        // hashing to fixed-length hex stays the point — bounded and flat
        // regardless of what arrives.
        const raw = 'some/evil/../key';
        const { store, claimed } = recordingStore();
        await checkIdempotency(makeCtx(raw), 'user-slash', store);

        expect(claimed[0]).toBe(expectedId('user-slash', raw));
        expect(claimed[0]).not.toContain('/');
    });

    it('passes the 24h TTL to the store', async () => {
        let seen: number | undefined;
        const store: IdempotencyStore = {
            async claim(_id, ttlMs) {
                seen = ttlMs;
                return 'claimed';
            },
            async settle() {},
        };
        await checkIdempotency(makeCtx('k'), 'u', store);
        expect(seen).toBe(24 * 60 * 60 * 1000);
    });
});

describe('checkIdempotency — claim outcomes', () => {
    it('returns null so the handler proceeds when the key is newly claimed', async () => {
        const { store } = recordingStore('claimed');
        expect(await checkIdempotency(makeCtx('k'), 'u', store)).toBeNull();
    });

    it('throws so the handler can 409 when the key is already in flight', async () => {
        const { store } = recordingStore('in-progress');
        await expect(checkIdempotency(makeCtx('k'), 'u', store)).rejects.toBeInstanceOf(
            IdempotencyInProgressError,
        );
    });

    it('returns the recorded response for replay', async () => {
        const body = { success: true, data: { postId: 'p-1' } };
        const { store } = recordingStore({ replay: body });
        expect(await checkIdempotency(makeCtx('k'), 'u', store)).toEqual({ cached: body });
    });
});

describe('saveIdempotencyResult', () => {
    it('settles under the same uid-prefixed id', async () => {
        const { store, settled } = recordingStore();
        const body = { success: true, data: { postId: 'p-1' } };
        await saveIdempotencyResult(makeCtx('save-key'), 'user-save', body, store);

        expect(settled).toEqual([{ id: expectedId('user-save', 'save-key'), response: body }]);
    });

    it('is a no-op without the header', async () => {
        const { store, settled } = recordingStore();
        await saveIdempotencyResult(makeCtx(null), 'user-save', { ok: true }, store);
        expect(settled).toEqual([]);
    });
});
