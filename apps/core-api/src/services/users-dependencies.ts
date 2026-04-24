import { getAdminDb } from '../lib/firebase-admin.js';
import type {
    UserDependencies,
    UpdateProfileDto,
} from '@vox-pop/core/services/users-dependencies';

// Re-export for app callers that want the type without reaching into core.
export type { UserDependencies, UpdateProfileDto };

/**
 * Firebase-wired `UserDependencies` binding for core-api.
 *
 * **PR #2 scope**: only `listAllHandles` is implemented — that's all
 * `UserService.getAllPublicHandles` (the handles endpoint) calls. Every
 * other method throws a "not yet ported" error with a pointer to the
 * binding file. As subsequent PRs port more route handlers, each new
 * method gets filled in.
 *
 * Why the stub-and-throw pattern instead of implementing everything
 * upfront:
 *   1. apps/web/src/services/users-dependencies.ts is 281 lines of
 *      Firebase-specific code. Porting the whole thing in PR #2 would
 *      make this PR ~1000+ lines and review would suffer.
 *   2. TypeScript still requires a full `UserDependencies` impl to
 *      construct `UserService`. The throwing stubs satisfy the type
 *      contract while making the unimplemented state explicit at runtime.
 *   3. Each new route handler forces the specific methods it needs,
 *      revealing the exact per-endpoint dependency surface — useful
 *      guidance for the port order.
 */

function handlesCollection() {
    return getAdminDb().collection('handles');
}

const notYetPorted = (method: string): never => {
    throw new Error(
        `[core-api users-dependencies] ${method} is not yet ported. See apps/core-api/src/services/users-dependencies.ts and apps/web/src/services/users-dependencies.ts for the binding to mirror.`,
    );
};

export const firebaseUserDependencies: UserDependencies = {
    // --- Implemented ---

    async listAllHandles() {
        // Sitemap enumeration only needs the handle strings (doc IDs), not
        // the uid bodies. `.listDocuments()` fetches references only — no
        // document body reads — which is dramatically cheaper than `.get()`
        // for collections of any meaningful size.
        const refs = await handlesCollection().listDocuments();
        return refs.map((ref) => ref.id);
    },

    // --- Stubbed — fill in as each route handler ports ---

    async resolveHandle(_handle: string) {
        return notYetPorted('resolveHandle');
    },

    async findProfileByHandleField(_handle: string) {
        return notYetPorted('findProfileByHandleField');
    },

    async findProfileByUsernameField(_username: string) {
        return notYetPorted('findProfileByUsernameField');
    },

    async getProfileByUid(_uid: string) {
        return notYetPorted('getProfileByUid');
    },

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
