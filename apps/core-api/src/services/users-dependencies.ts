import { getAdminDb } from '../lib/firebase-admin.js';
import { ProfileViewSchema } from 'shared/types';
import type { ProfileView } from 'shared/types';
import { logger } from '../lib/logger.js';
import type {
    UserDependencies,
    UpdateProfileDto,
} from '@vox-pop/core/services/users-dependencies';

// Re-export for app callers that want the type without reaching into core.
export type { UserDependencies, UpdateProfileDto };

/**
 * Firebase-wired `UserDependencies` binding for core-api.
 *
 * **Scope as of this PR**: the `getUserData` read path is fully implemented
 * (`resolveHandle`, `findProfileByHandleField`, `findProfileByUsernameField`,
 * `getProfileByUid`) plus `listAllHandles` for the sitemap endpoint. The
 * remaining methods (`getProfilesByIds`, `getUserRecordByUid`,
 * `getPhoneNumbersForUids`, `ensureUserStub`, `updateUserProfile`) are
 * stubbed and will be filled in as endpoints that need them port.
 *
 * Parity source: `apps/web/src/services/users-dependencies.ts`. The logic
 * below is a direct mirror; only imports (no `server-only`, logger is pino
 * not Winston) and a couple of module-level helpers differ.
 */

function usersCollection() {
    return getAdminDb().collection('users');
}

function handlesCollection() {
    return getAdminDb().collection('handles');
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

const notYetPorted = (method: string): never => {
    throw new Error(
        `[core-api users-dependencies] ${method} is not yet ported. See apps/core-api/src/services/users-dependencies.ts and apps/web/src/services/users-dependencies.ts for the binding to mirror.`,
    );
};

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

    async getProfilesByIds(_uids: string[]) {
        return notYetPorted('getProfilesByIds');
    },

    async getUserRecordByUid(_uid: string) {
        return notYetPorted('getUserRecordByUid');
    },

    async getPhoneNumbersForUids(_uids: string[]) {
        return notYetPorted('getPhoneNumbersForUids');
    },

    async ensureUserStub(_uid: string) {
        return notYetPorted('ensureUserStub');
    },

    async updateUserProfile(_uid: string, _updates: UpdateProfileDto) {
        return notYetPorted('updateUserProfile');
    },

    now(): Date {
        return new Date();
    },
};
