import { getAdminDb } from '../../../lib/firebase-admin.js';
import type { HydrationDependencies } from '@antiphony/core/ports/hydration-dependencies';
import { firebaseUserDependencies } from './users-dependencies.js';
import { firebaseCoreServices } from './core-services-firebase.js';
import { firebaseReplyDependencies } from './replies-dependencies.js';
import { firebasePromptDependencies } from './prompts-dependencies.js';

export type { HydrationDependencies };

/**
 * Firebase-wired `HydrationDependencies` binding for core-api.
 *
 * **Scope**: all `HydrationDependencies` methods are now implemented —
 * `countOrgMembers` (`hydrateOrganization`), `loadUser` (`hydratePrompt`),
 * `getOrgMemberRole` (`hydrateOrganizations` with a viewer — backs
 * `GET /users/me/organizations`), `getUsersByIds`
 * (`hydrateRepliesWithRecipient` when `includePrivateData` is on),
 * `getOrgName`, `getReplyEnrichmentsByIds`, and `loadPrompt`
 * (`hydrateReply` — backs `POST /replies`, which was 500ing on the stub).
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

    async getOrgName(orgId: string) {
        if (!orgId || !orgId.trim()) return null;
        const doc = await getAdminDb().collection('organizations').doc(orgId).get();
        if (!doc.exists) return null;
        return (doc.data()?.name as string) || null;
    },

    async getReplyEnrichmentsByIds(replyIds: string[]) {
        // Delegate to the reply-deps binding which owns the enrichments
        // namespace path (`enrichments/replies/items/{id}`) and the
        // schema-validation envelope. Keeps the namespace concern in one
        // place — the hydrator doesn't need to know where enrichments live.
        return firebaseReplyDependencies.getReplyEnrichmentsByIds(replyIds);
    },

    async loadPrompt(id: string) {
        // Delegate to the prompts binding's `getDocumentById`, which owns the
        // `prompts/{id}` read, the empty-string guard, the existence check,
        // and the robust `{ id: doc.id, ...data }` PromptDocumentSchema parse.
        // Mirrors the delegation pattern used by `loadUser`/`getUsersByIds`/
        // `getReplyEnrichmentsByIds` above — keeps the prompt-loading concern
        // in one place rather than duplicating the Firestore read here.
        // (Apps/web wraps prompt loads in a DataLoader inside React's
        // `cache()` for per-render batching; core-api is per-request atomic,
        // so a naive single read is correct — see the file header.)
        return firebasePromptDependencies.getDocumentById(id);
    },
};
