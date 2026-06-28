import admin from 'firebase-admin';
import { getAdminDb, getAdminAuth } from '../../../lib/firebase-admin.js';
import { UserRecordSchema } from 'shared/types/records';
import { ProfileViewSchema, ProfileViewBasicSchema } from 'shared/types/views';
import type { ProfileView } from 'shared/types/views';
import { ConflictError } from 'shared/errors';
import { logger } from '../../../lib/logger.js';
import type {
    UserDependencies,
    UpdateProfileDto,
} from '@antiphony/core/ports/users-dependencies';

// Re-export for app callers that want the type without reaching into core.
export type { UserDependencies, UpdateProfileDto };

/**
 * Firebase-wired `UserDependencies` binding for core-api.
 *
 * **Scope as of this PR**: the full read path + write surface except
 * `getUserRecordByUid`. `updateUserProfile` (backs PATCH /users/me) is
 * a transactional handle-swap + profile-merge. `ensureUserStub` (backs
 * users.ensureUserExists → POST /replies on apps/web's embed flow)
 * writes a minimal user document on first sight.
 *
 * Parity source: `apps/web/src/services/users-dependencies.ts`. The logic
 * below is a direct mirror; only imports (no `server-only`, logger is pino
 * not Winston) and a couple of module-level helpers differ.
 */

// Firestore's `getAll()` caps at 1000 document refs per call. `getProfilesByIds`
// chunks against this limit rather than hoping callers don't exceed it.
const FIRESTORE_GETALL_LIMIT = 1000;

// Firebase Admin's `auth.getUsers()` accepts up to 100 identifiers per call.
// `getPhoneNumbersForUids` chunks against this limit.
const FIREBASE_AUTH_GETUSERS_LIMIT = 100;

function usersCollection() {
    return getAdminDb().collection('users');
}

function handlesCollection() {
    return getAdminDb().collection('handles');
}

/**
 * Basic-shape fallback for legacy user docs that fail `ProfileViewBasicSchema`
 * validation. Mirrors the apps/web binding's `basicFallbackProfile` — PII and
 * admin fields explicitly omitted so a single legacy record can't leak through
 * the batch hydration path.
 */
function basicFallbackProfile(userData: FirebaseFirestore.DocumentData, id: string): ProfileView {
    return {
        id,
        handle: userData.handle,
        displayName: userData.displayName,
        avatarUrl: userData.avatarUrl,
        bio: userData.bio,
        stats: userData.stats || { followers: 0, following: 0, prompts: 0 },
        badges: userData.badges,
        isVerified: userData.isVerified,
        createdAt: userData.createdAt,
    } as unknown as ProfileView;
}

/**
 * Best-effort profile construction used when `ProfileViewSchema.safeParse`
 * fails on stored data. Legacy docs predate the schema, so we construct a
 * minimal ProfileView rather than returning null — matches caller
 * expectations from apps/web.
 */
function fallbackProfile(
    userData: FirebaseFirestore.DocumentData,
    id: string,
    extras?: Partial<ProfileView>,
): ProfileView {
    return {
        ...userData,
        id,
        stats: userData.stats || { followers: 0, following: 0, prompts: 0 },
        ...(extras ?? {}),
    } as unknown as ProfileView;
}

async function parseProfileFromDoc(
    doc: FirebaseFirestore.DocumentSnapshot,
    extras?: { rssSummary?: unknown; inputHandle?: string },
): Promise<ProfileView | null> {
    if (!doc.exists) return null;
    const userData = doc.data();
    if (!userData) return null;
    if (userData.status === 'deactivated') return null;

    const combined = {
        ...userData,
        id: doc.id,
        ...(extras?.rssSummary !== undefined ? { rssSummary: extras.rssSummary } : {}),
    };

    const result = ProfileViewSchema.safeParse(combined);
    if (result.success) return result.data;

    logger.error(
        { docId: doc.id, issues: result.error.issues },
        '[users-deps] schema validation failed; falling back to loose shape',
    );

    const fallbackExtras: Partial<ProfileView> = {};
    if (extras?.rssSummary !== undefined) {
        (fallbackExtras as { rssSummary?: unknown }).rssSummary = extras.rssSummary;
    }
    if (extras?.inputHandle) {
        (fallbackExtras as { handle?: string }).handle =
            (userData.handle as string | undefined) || extras.inputHandle;
        (fallbackExtras as { unreadReplyCount?: number }).unreadReplyCount = userData.unreadReplyCount || 0;
        (fallbackExtras as { newReplierCount?: number }).newReplierCount = userData.newReplierCount || 0;
    }
    return fallbackProfile(userData, doc.id, fallbackExtras);
}

export const firebaseUserDependencies: UserDependencies = {
    // --- Implemented: getUserData read path + sitemap ---

    async resolveHandle(handle: string) {
        const snap = await handlesCollection().doc(handle).get();
        if (!snap.exists) return null;
        const data = snap.data();
        return data?.uid ?? null;
    },

    async findProfileByHandleField(handle: string) {
        const snap = await usersCollection().where('handle', '==', handle).limit(1).get();
        if (snap.empty) return null;
        return parseProfileFromDoc(snap.docs[0], { inputHandle: handle });
    },

    async findProfileByUsernameField(username: string) {
        const snap = await usersCollection().where('username', '==', username).limit(1).get();
        if (snap.empty) return null;
        return parseProfileFromDoc(snap.docs[0], { inputHandle: username });
    },

    async getProfileByUid(uid: string) {
        const userRef = usersCollection().doc(uid);
        const rssRef = userRef.collection('enrichment').doc('rss');
        const [docSnap, rssSnap] = await Promise.all([userRef.get(), rssRef.get()]);
        const rssSummary = rssSnap.exists ? rssSnap.data() : undefined;
        return parseProfileFromDoc(docSnap, { rssSummary });
    },

    async listAllHandles() {
        // Sitemap enumeration only needs the handle strings (doc IDs), not
        // the uid bodies. `.listDocuments()` fetches references only — no
        // document body reads — which is dramatically cheaper than `.get()`
        // for collections of any meaningful size.
        const refs = await handlesCollection().listDocuments();
        return refs.map((ref) => ref.id);
    },

    // --- Stubbed — fill in as each route handler ports ---

    async getProfilesByIds(uids: string[]) {
        if (uids.length === 0) return [];
        const uniqueUids = Array.from(new Set(uids));
        const db = getAdminDb();

        // Parallelize chunks — each chunk is an independent getAll() round
        // trip. Firestore's getAll cap is 1000 refs per call, so for the
        // overwhelming majority of inputs this resolves in a single chunk;
        // parallelization matters mostly for unusually large ownership-check
        // paths in the write tier.
        const chunks: string[][] = [];
        for (let i = 0; i < uniqueUids.length; i += FIRESTORE_GETALL_LIMIT) {
            chunks.push(uniqueUids.slice(i, i + FIRESTORE_GETALL_LIMIT));
        }
        const chunkResults = await Promise.all(
            chunks.map((chunk) =>
                db.getAll(...chunk.map((uid) => usersCollection().doc(uid))),
            ),
        );
        const snapshots: FirebaseFirestore.DocumentSnapshot[] = chunkResults.flat();

        const profiles: ProfileView[] = [];
        for (const doc of snapshots) {
            if (!doc.exists) continue;
            const userData = doc.data();
            if (!userData) continue;

            // Hydration-layer narrowing: batch lookup is the default feeder
            // for hydrating post authors (across every AudioPostView), so it
            // MUST NOT admit PII or admin fields. Explicit
            // field selection + ProfileViewBasicSchema ensures
            // email/phoneNumber/lastSeenAt/unreadReplyCount/settings/
            // blockedUsers/followers/following/reportCount/isBanned never cross
            // the hydration boundary. Callers that legitimately need more
            // fields (self profile, phone enrichment for lite repliers) use
            // dedicated paths.
            const result = ProfileViewBasicSchema.safeParse({
                id: doc.id,
                handle: userData.handle,
                displayName: userData.displayName,
                avatarUrl: userData.avatarUrl,
                bio: userData.bio,
                stats: userData.stats,
                badges: userData.badges,
                isVerified: userData.isVerified,
                createdAt: userData.createdAt,
            });
            if (result.success) {
                profiles.push(result.data as ProfileView);
            } else {
                logger.error(
                    { uid: doc.id, issues: result.error.format() },
                    '[users-deps] ProfileViewBasicSchema validation failed; falling back to loose shape',
                );
                profiles.push(basicFallbackProfile(userData, doc.id));
            }
        }
        return profiles;
    },

    async getUserRecordByUid(uid: string) {
        const doc = await usersCollection().doc(uid).get();
        if (!doc.exists) return null;
        const data = doc.data();
        if (!data) return null;
        const result = UserRecordSchema.safeParse({ ...data, id: doc.id });
        if (!result.success) {
            logger.error(
                { uid, issues: result.error.issues },
                '[users-deps] getUserRecordByUid: schema validation failed',
            );
            return null;
        }
        return result.data;
    },

    async findUserByDid(did: string) {
        const snap = await usersCollection().where('bluesky.did', '==', did).limit(1).get();
        if (snap.empty) return null;
        return snap.docs[0].id;
    },

    async getPhoneNumbersForUids(uids: string[]) {
        const phoneMap = new Map<string, string>();
        if (uids.length === 0) return phoneMap;

        // Deduplicate before chunking — callers can pass the same uid many
        // times for a hot replier, and there's no reason to ask Auth twice.
        const uniqueUids = Array.from(new Set(uids));
        const chunks: string[][] = [];
        for (let i = 0; i < uniqueUids.length; i += FIREBASE_AUTH_GETUSERS_LIMIT) {
            chunks.push(uniqueUids.slice(i, i + FIREBASE_AUTH_GETUSERS_LIMIT));
        }

        try {
            const auth = getAdminAuth();
            // Parallelize chunk lookups. Firebase Admin getUsers caps each
            // call at 100 uids, so parallelization wins for any replier
            // population > 100 (CRM page on prolific prompts).
            const results = await Promise.all(
                chunks.map((chunk) => auth.getUsers(chunk.map((uid) => ({ uid })))),
            );
            for (const result of results) {
                for (const userRecord of result.users) {
                    if (userRecord.phoneNumber) {
                        phoneMap.set(userRecord.uid, userRecord.phoneNumber);
                    }
                }
            }
        } catch (err) {
            // Phone enrichment is best-effort; failures degrade gracefully so
            // a single failed Auth batch doesn't blank out the entire reply list.
            logger.error({ err }, '[users-deps] getPhoneNumbersForUids: Auth lookup failed');
        }
        return phoneMap;
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
                stats: { followers: 0, following: 0, prompts: 0 },
            });
            return true;
        } catch (err) {
            const code = (err as { code?: number })?.code;
            // 6 = ALREADY_EXISTS in gRPC / Firestore SDK.
            if (code === 6) return false;
            throw err;
        }
    },

    async removeBlueskyIdentity(uid: string) {
        // FieldValue.delete() removes just the `bluesky` field rather
        // than the whole doc. Idempotent — Firestore `update` with a
        // delete-sentinel on a missing field is a no-op (the doc must
        // exist; missing-doc throws NOT_FOUND, which the caller treats
        // as "nothing to disconnect" via the same idempotency contract).
        await usersCollection().doc(uid).update({
            bluesky: admin.firestore.FieldValue.delete(),
        });
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
