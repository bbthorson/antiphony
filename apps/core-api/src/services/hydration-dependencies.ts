import { getAdminDb } from '../lib/firebase-admin.js';
import type { HydrationDependencies } from '@vox-pop/core/services/hydration-dependencies';
import { firebaseUserDependencies } from './users-dependencies.js';
import { firebaseCoreServices } from './core-services-firebase.js';

export type { HydrationDependencies };

/**
 * Firebase-wired `HydrationDependencies` binding for core-api.
 *
 * **Scope as of this PR**: implements `countOrgMembers` (for
 * `hydrateOrganization`), `loadUser` (for `hydratePrompt`),
 * `getOrgMemberRole` (for `hydrateOrganizations` when called with a
 * viewer — backs `GET /users/me/organizations`), and `getUsersByIds` (for
 * `hydrateRepliesWithRecipient` when `includePrivateData` is on — backs
 * the reply-read endpoints in Batch A2). Remaining methods (`loadPrompt`,
 * `getOrgName`) stay stubbed and fill in as org-admin + invite endpoints port.
 *
 * **Key difference vs. apps/web's binding**: no `DataLoader` wrapping.
 * Apps/web uses `DataLoader` inside React's `cache()` for per-render batch
 * dedup — that's an RSC concern. Core-api processes requests atomically
 * per HTTP call with no render-lifecycle, so a naive non-batching
 * implementation is correct (just slower if a single request needs many
 * lookups). When an endpoint genuinely surfaces an N+1, reintroduce
 * request-scoped DataLoader via Hono's context storage at that point.
 *
 * Parity source: `apps/web/src/services/hydration-dependencies.ts`.
 */

const notYetPorted = (method: string): never => {
    throw new Error(
        `[core-api hydration-dependencies] ${method} is not yet ported. See apps/core-api/src/services/hydration-dependencies.ts and apps/web/src/services/hydration-dependencies.ts for the binding to mirror.`,
    );
};

export const firebaseHydrationDependencies: HydrationDependencies = {
    // --- Implemented: hydrateOrganization path ---

    async countOrgMembers(orgId: string) {
        const snapshot = await getAdminDb()
            .collection(`organizations/${orgId}/members`)
            .count()
            .get();
        return snapshot.data().count;
    },

    async loadUser(id: string) {
        // Naive single-read: delegate to `firebaseUserDependencies.getProfileByUid`.
        // Apps/web wraps this in a DataLoader inside React's `cache()` for
        // per-render batching — that's an RSC concern. Core-api is
        // per-request atomic; if a specific endpoint surfaces an N+1 (many
        // loadUser calls in one request), reintroduce request-scoped
        // batching via Hono context storage at that point.
        if (!id || !id.trim()) return null;
        return firebaseUserDependencies.getProfileByUid(id);
    },

    async getOrgMemberRole(orgId: string, userId: string) {
        // Empty orgId or userId would blow up Firestore (`doc('')` throws).
        // Treat as "not a member" rather than letting it surface as a 500.
        if (!orgId || !userId || !userId.trim()) return undefined;
        const doc = await getAdminDb()
            .collection(`organizations/${orgId}/members`)
            .doc(userId)
            .get();
        if (!doc.exists) return undefined;
        const role = doc.data()?.role;
        if (role === 'owner' || role === 'admin' || role === 'member') return role;
        return undefined;
    },

    async getUsersByIds(ids: string[], options?: { includePrivateData?: boolean }) {
        // Delegate to the users CoreServices binding — which calls
        // `UserService.getUsersByIds` → `users-deps.getProfilesByIds` (and
        // optionally `getPhoneNumbersForUids` for lite repliers when
        // `includePrivateData` is set). Keeps peer-service access flowing
        // through the Phase 2.5 DI seam instead of reaching past it.
        //
        // Circular module-load note: core-services-firebase imports this
        // binding. Since `firebaseCoreServices` is only dereferenced here
        // at CALL time (not at module-load), ESM's live-binding semantics
        // resolve the cycle — the aggregate is finalized before any HTTP
        // request ever arrives.
        return firebaseCoreServices.users.getUsersByIds(ids, options);
    },

    // --- Stubbed — fill in as org invite + reply-write endpoints port ---

    async loadPrompt(_id: string) {
        return notYetPorted('loadPrompt');
    },

    async getOrgName(_orgId: string) {
        return notYetPorted('getOrgName');
    },
};
