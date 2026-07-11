import admin from 'firebase-admin';
import { getAdminDb } from '../../../lib/firebase-admin.js';
import { ConflictError } from 'shared/errors';
import type {
    UserDependencies,
    UpdateProfileDto,
} from '@antiphony/core/ports/users-dependencies';

// Re-export for app callers that want the type without reaching into core.
export type { UserDependencies, UpdateProfileDto };

/**
 * Firebase-wired `UserDependencies` binding for core-api.
 *
 * Scope: the user-identity primitives the `/system/*` routes need —
 * `findUserByDid` (DID→uid), `ensureUserStub` (first-sight identity doc),
 * `updateUserProfile` (transactional handle claim during atproto-signin
 * onboarding), and `setBlueskyIdentity`. The public-profile read projection
 * was retired with the author-shape change (see specs/core-surface.md).
 */

function usersCollection() {
    return getAdminDb().collection('users');
}

function handlesCollection() {
    return getAdminDb().collection('handles');
}

export const firebaseUserDependencies: UserDependencies = {
    async findUserByDid(did: string) {
        const snap = await usersCollection().where('bluesky.did', '==', did).limit(1).get();
        if (snap.empty) return null;
        return snap.docs[0].id;
    },

    async ensureUserStub(uid: string) {
        // Use `create()` instead of `get()` + `set()` to close the TOCTOU
        // race where two concurrent requests for the same uid both see the
        // doc missing and both attempt to create. `create()` fails with
        // ALREADY_EXISTS (code 6) — we map that to "already exists, nothing
        // to do" and return false.
        const userRef = usersCollection().doc(uid);
        try {
            await userRef.create({
                id: uid,
                handle: '',
                createdAt: admin.firestore.Timestamp.now(),
            });
            return true;
        } catch (err) {
            const code = (err as { code?: number })?.code;
            // 6 = ALREADY_EXISTS in gRPC / Firestore SDK.
            if (code === 6) return false;
            throw err;
        }
    },

    async setBlueskyIdentity(uid: string, identity: { handle: string; did: string }) {
        // `update` requires the user doc to exist (NOT_FOUND if missing).
        // That matches the pre-port behavior — apps/web's callback also
        // called `update` and would 500 on a missing user, which is the
        // right semantics: callback fires for an already-authenticated
        // user, so a missing user doc is a genuine error.
        await usersCollection().doc(uid).update({
            bluesky: identity,
        });
    },

    async updateUserProfile(uid: string, updates: UpdateProfileDto) {
        const db = getAdminDb();
        await db.runTransaction(async (t) => {
            const userRef = usersCollection().doc(uid);
            const userDoc = await t.get(userRef);
            const currentData = userDoc.data() || {};

            // Handle swap — atomic check + claim + release. Throws
            // ConflictError (409) if the requested handle is taken by
            // someone else; caller maps this to 409.
            if (updates.handle && updates.handle !== currentData.handle) {
                const newHandleRef = handlesCollection().doc(updates.handle);
                const newHandleDoc = await t.get(newHandleRef);

                if (newHandleDoc.exists && newHandleDoc.data()?.uid !== uid) {
                    throw new ConflictError('Handle is already taken');
                }

                t.set(newHandleRef, { uid });

                if (currentData.handle) {
                    const oldHandleRef = handlesCollection().doc(currentData.handle);
                    t.delete(oldHandleRef);
                }
            }

            const finalUpdates: UpdateProfileDto = { ...updates, updatedAt: new Date() };

            // First-time initialization — set id/createdAt for new users.
            if (!currentData.createdAt) {
                finalUpdates.id = uid;
                finalUpdates.createdAt = new Date();
            }

            t.set(userRef, finalUpdates, { merge: true });
        });
    },

    now(): Date {
        return new Date();
    },
};
