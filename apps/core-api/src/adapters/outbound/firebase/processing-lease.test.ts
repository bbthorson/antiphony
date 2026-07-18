import { describe, it, expect, vi, beforeEach } from 'vitest';
// Real SDK, only to recognise the `FieldValue.delete()` sentinel below.
import admin from 'firebase-admin';

/**
 * The lease binding's own logic: contention and fencing.
 *
 * The end-to-end test in `rest/posts-processing.test.ts` drives this binding
 * too, but only ever on the uncontended path — one runner, claim granted,
 * release matches. That path stays green whether or not the guards work, which
 * is how a contention check that could never fire (`toMillis` only, against a
 * store that hands back `Date`) went unnoticed. These exercise the branches
 * that only a SECOND runner reaches.
 */

// --- Minimal in-memory Firestore -------------------------------------------
// Same semantics as the end-to-end harness's store, narrowed to what the lease
// touches: dotted-path writes and a `FieldValue.delete()` that truly removes.
const docs = new Map<string, Record<string, unknown>>();

function isDeleteSentinel(v: unknown): boolean {
    const candidate = v as { isEqual?: (o: unknown) => boolean } | null;
    return (
        typeof candidate?.isEqual === 'function' &&
        candidate.isEqual(admin.firestore.FieldValue.delete())
    );
}

function makeDocRef(name: string, id: string) {
    const key = `${name}/${id}`;
    return {
        id,
        get: async () => ({ exists: docs.has(key), id, data: () => docs.get(key) }),
        update: async (data: Record<string, unknown>) => {
            const cur = { ...(docs.get(key) ?? {}) };
            for (const [k, v] of Object.entries(data)) {
                const [head, leaf] = k.split('.');
                if (leaf === undefined) {
                    cur[head] = v;
                    continue;
                }
                const nested = { ...((cur[head] as Record<string, unknown>) ?? {}) };
                if (isDeleteSentinel(v)) delete nested[leaf];
                else nested[leaf] = v;
                cur[head] = nested;
            }
            docs.set(key, cur);
        },
    };
}

const db = {
    collection: (name: string) => ({ doc: (id: string) => makeDocRef(name, id) }),
    runTransaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
            get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
            update: (ref: { update: (d: Record<string, unknown>) => void }, d: Record<string, unknown>) =>
                ref.update(d),
        }),
};

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => db,
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({ bucket: () => ({ name: 'test-bucket' }) }),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { firebaseAudioProcessingDependencies: deps } = await import(
    './audio-processing-dependencies.js'
);
const { COLLECTIONS, NSID } = await import('shared/nsid');

const POSTS = COLLECTIONS[NSID.AudioPost];
const POST_ID = 'p1';

/** Seed a post whose `processing` map holds `leaseUntil` (or none). */
function seed(leaseUntil?: unknown) {
    docs.clear();
    const processing: Record<string, unknown> = { denoise: 'pending' };
    if (leaseUntil !== undefined) processing.leaseUntil = leaseUntil;
    docs.set(`${POSTS}/${POST_ID}`, { processing });
}

function storedLease(): unknown {
    const processing = docs.get(`${POSTS}/${POST_ID}`)?.processing as
        | Record<string, unknown>
        | undefined;
    return processing?.leaseUntil;
}

/** A Firestore `Timestamp`, which is what a real read-back actually returns. */
function timestamp(d: Date) {
    return { toMillis: () => d.getTime() };
}

describe('processing lease binding', () => {
    beforeEach(() => {
        docs.clear();
        vi.useRealTimers();
    });

    describe('claim', () => {
        it('declines while another runner holds an unexpired lease', async () => {
            seed(new Date(Date.now() + 60_000));

            expect(await deps.claimProcessingLease('vox-pop', POST_ID, new Date())).toBe(false);
        });

        it('declines against a Timestamp lease as well as a Date one', async () => {
            // Real Firestore returns a `Timestamp`; the in-memory store returns
            // the `Date` that was written. A check that handles only one of
            // them passes every test AND protects nothing in production —
            // whichever half it missed reads as "unheld".
            seed(timestamp(new Date(Date.now() + 60_000)));

            expect(await deps.claimProcessingLease('vox-pop', POST_ID, new Date())).toBe(false);
        });

        it('grants a lapsed lease, so a dead runner cannot strand the post', async () => {
            seed(new Date(Date.now() - 1));
            const mine = new Date(Date.now() + 60_000);

            expect(await deps.claimProcessingLease('vox-pop', POST_ID, mine)).toBe(true);
            expect(storedLease()).toEqual(mine);
        });

        it('grants when no lease is held', async () => {
            seed();
            const mine = new Date(Date.now() + 60_000);

            expect(await deps.claimProcessingLease('vox-pop', POST_ID, mine)).toBe(true);
            expect(storedLease()).toEqual(mine);
        });

        it('declines a post with no processing state rather than creating one', async () => {
            docs.clear();
            docs.set(`${POSTS}/${POST_ID}`, {});

            expect(await deps.claimProcessingLease('vox-pop', POST_ID, new Date())).toBe(false);
            expect(docs.get(`${POSTS}/${POST_ID}`)).toEqual({});
        });

        it('declines a post that does not exist', async () => {
            docs.clear();

            expect(await deps.claimProcessingLease('vox-pop', POST_ID, new Date())).toBe(false);
        });
    });

    describe('release', () => {
        it('clears its own lease', async () => {
            const mine = new Date(Date.now() + 60_000);
            seed(mine);

            await deps.releaseProcessingLease('vox-pop', POST_ID, mine);

            expect(storedLease()).toBeUndefined();
            // Removed, not set to a sentinel or a past time: the absent case
            // and the released case must read as one state.
            expect(docs.get(`${POSTS}/${POST_ID}`)?.processing).toEqual({ denoise: 'pending' });
        });

        it('leaves a successor lease alone when its own has been superseded', async () => {
            // The fencing case, and the reason release takes a token at all.
            // Runner A overruns its lease; B claims; A finally reaches its
            // `finally`. An unconditional delete here would clear B's live
            // claim and let a third delivery run concurrently with B — the
            // exact double-billing overlap the lease exists to prevent, and it
            // would fire precisely when the system is already running slow.
            const theirs = new Date(Date.now() + 60_000);
            seed(theirs);

            const mineExpired = new Date(Date.now() - 60_000);
            await deps.releaseProcessingLease('vox-pop', POST_ID, mineExpired);

            expect(storedLease()).toEqual(theirs);
        });

        it('fences against a Timestamp read-back, not just a Date', async () => {
            const theirs = new Date(Date.now() + 60_000);
            seed(timestamp(theirs));

            await deps.releaseProcessingLease('vox-pop', POST_ID, new Date(Date.now() - 60_000));

            expect(storedLease()).not.toBeUndefined();
        });

        it('is a no-op on a post that disappeared mid-pass', async () => {
            docs.clear();

            await expect(
                deps.releaseProcessingLease('vox-pop', POST_ID, new Date()),
            ).resolves.toBeUndefined();
        });
    });
});
