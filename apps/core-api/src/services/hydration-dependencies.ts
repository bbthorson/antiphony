import { getAdminDb } from '../lib/firebase-admin.js';
import type { HydrationDependencies } from '@vox-pop/core/services/hydration-dependencies';
import { firebaseUserDependencies } from './users-dependencies.js';

export type { HydrationDependencies };

/**
 * Firebase-wired `HydrationDependencies` binding for core-api.
 *
 * **Scope as of this PR**: implements the methods needed by
 * `hydrateOrganization` (the org fallback in `FeedService.resolveHandle`):
 * `countOrgMembers`. Other methods (`loadUser`, `loadPrompt`,
 * `getOrgMemberRole`, `getOrgName`, `getUsersByIds`) are stubbed and will
 * fill in as prompts/replies endpoints land.
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

    // --- Stubbed — fill in as prompts/replies endpoints port ---

    async loadUser(id: string) {
        // When prompts/replies endpoints port (PR #4+), this should delegate
        // to `firebaseUserDependencies.getProfileByUid(id)` for a naive
        // single-read impl. Wrap in a request-scoped DataLoader if/when an
        // endpoint shows an N+1 problem.
        void firebaseUserDependencies; // silence unused-import until loadUser ports
        return notYetPorted(`loadUser(${id})`);
    },

    async loadPrompt(_id: string) {
        return notYetPorted('loadPrompt');
    },

    async getOrgMemberRole(_orgId: string, _userId: string) {
        return notYetPorted('getOrgMemberRole');
    },

    async getOrgName(_orgId: string) {
        return notYetPorted('getOrgName');
    },

    async getUsersByIds(_ids: string[], _options?: { includePrivateData?: boolean }) {
        return notYetPorted('getUsersByIds');
    },
};
