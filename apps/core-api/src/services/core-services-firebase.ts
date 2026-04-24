import { UserService } from '@vox-pop/core/services/users';
import { OrganizationService } from '@vox-pop/core/services/organizations';
import { HydrationService } from '@vox-pop/core/services/hydration';
import { FeedService } from '@vox-pop/core/services/feeds';
import { PromptService } from '@vox-pop/core/services/prompts';
import { ReplyService } from '@vox-pop/core/services/replies';
import { rssService as rssServiceSingleton } from '@vox-pop/core/services/rss';
import { makeStorageService } from '@vox-pop/core/services/storage';
import type { CoreServices } from '@vox-pop/core/services/core-services';
import { firebaseUserDependencies } from './users-dependencies.js';
import { firebaseOrganizationDependencies } from './organizations-dependencies.js';
import { firebaseHydrationDependencies } from './hydration-dependencies.js';
import { firebasePromptDependencies } from './prompts-dependencies.js';
import { firebaseReplyDependencies } from './replies-dependencies.js';
import { firebaseBlobStore } from './storage-dependencies.js';

/**
 * Firebase-wired `CoreServices` binding for core-api.
 *
 * **Scope as of this PR**:
 *   - `UserService` — fully constructed (getUserData path).
 *   - `PromptService` — constructed; `getPromptData` (direct call),
 *     `getPromptsForUser`, and `getPromptsForOrgContext` (both via CoreServices)
 *     are reachable. Binding impls of `getDocumentById`, `queryByAuthor`,
 *     `queryByOrg` back them.
 *   - `HydrationService` — `hydrateOrganization` + `hydratePrompt` reachable.
 *   - `OrganizationService` — `getOrganizationBySlug` reachable.
 *   - `FeedService` — `resolveHandle`, `getUserProfileData`, `getOrgProfileData`,
 *     plus `getPersonReplies` (Batch A2) reachable — all routed via the
 *     prompts + rss + replies CoreServices wiring.
 *   - `RssService` — singleton from `@vox-pop/core/services/rss` used directly
 *     (no Firebase binding; it's a standalone URL-fetch class).
 *   - `ReplyService` — **wired this PR (Batch A2)**. `getRepliesForPrompt`,
 *     `getRepliesForPrompts`, and `searchReplies` reachable. Write methods
 *     (create, update, bulk, mark-read) still fall through to
 *     `notYetPorted` stubs on the binding until Batch A4 ports.
 *
 * Note: no React `cache()` wrappers (unlike apps/web's binding). Core-api
 * isn't an RSC runtime.
 *
 * ## Module-load order
 *
 * All three constructed services (UserService, OrganizationService,
 * HydrationService) depend on `coreServices` for peer-service calls. With
 * the throw-stubs for unimplemented methods, there's no cycle at
 * module-load time — the stubs capture string identifiers, not live
 * references. When a real cross-service call shows up (e.g., once
 * PromptService is wired and uses `services.users.getUserDataByUid`), it
 * goes through the object reference below; no lazy-singleton needed here.
 */

const notYetPorted = (method: string): never => {
    throw new Error(
        `[core-api core-services-firebase] ${method} is not yet ported. See apps/core-api/src/services/core-services-firebase.ts.`,
    );
};

// The CoreServices aggregate is built first with stubs for unwired services,
// then passed to service constructors. Wired methods below replace the stubs.
export const firebaseCoreServices: CoreServices = {
    hydration: {
        hydratePrompt: (...args: Parameters<CoreServices['hydration']['hydratePrompt']>) =>
            hydrationService.hydratePrompt(...args),
        hydrateReply: (...args: Parameters<CoreServices['hydration']['hydrateReply']>) =>
            hydrationService.hydrateReply(...args),
        hydrateRepliesWithRecipient: (
            ...args: Parameters<CoreServices['hydration']['hydrateRepliesWithRecipient']>
        ) => hydrationService.hydrateRepliesWithRecipient(...args),
        hydrateOrganization: (...args: Parameters<CoreServices['hydration']['hydrateOrganization']>) =>
            hydrationService.hydrateOrganization(...args),
        hydrateOrganizations: (...args: Parameters<CoreServices['hydration']['hydrateOrganizations']>) =>
            hydrationService.hydrateOrganizations(...args),
        hydrateMembers: (...args: Parameters<CoreServices['hydration']['hydrateMembers']>) =>
            hydrationService.hydrateMembers(...args),
        hydrateInvite: (...args: Parameters<CoreServices['hydration']['hydrateInvite']>) =>
            hydrationService.hydrateInvite(...args),
    },
    prompts: {
        getPromptsForUser: (...args: Parameters<CoreServices['prompts']['getPromptsForUser']>) =>
            promptService.getPromptsForUser(...args),
        getPromptsForOrgContext: (...args: Parameters<CoreServices['prompts']['getPromptsForOrgContext']>) =>
            promptService.getPromptsForOrgContext(...args),
        getPromptRecord: (...args: Parameters<CoreServices['prompts']['getPromptRecord']>) =>
            promptService.getPromptRecord(...args),
        getPromptRecordsByIds: (...args: Parameters<CoreServices['prompts']['getPromptRecordsByIds']>) =>
            promptService.getPromptRecordsByIds(...args),
        createPrompt: (...args: Parameters<CoreServices['prompts']['createPrompt']>) =>
            promptService.createPrompt(...args),
    },
    users: {
        getUserData: (handle: string) => userService.getUserData(handle),
        getUserDataByUid: (uid: string) => userService.getUserDataByUid(uid),
        getUsersByIds: (...args: Parameters<CoreServices['users']['getUsersByIds']>) =>
            userService.getUsersByIds(...args),
        ensureUserExists: () => notYetPorted('users.ensureUserExists'),
    },
    organizations: {
        getOrganizationBySlug: (slug: string, currentUserId?: string) =>
            organizationService.getOrganizationBySlug(slug, currentUserId),
    },
    replies: {
        getRepliesForPrompts: (...args: Parameters<CoreServices['replies']['getRepliesForPrompts']>) =>
            replyService.getRepliesForPrompts(...args),
    },
    rss: {
        parseFeed: (url: string, limit?: number) => rssServiceSingleton.parseFeed(url, limit),
    },
};

/**
 * Service singletons. Order doesn't matter at module-load because
 * firebaseCoreServices above is built first and captures `userService`,
 * `organizationService`, `hydrationService` by late binding (via arrow
 * functions that evaluate the identifiers at call time, not module-load).
 */
export const hydrationService = new HydrationService(firebaseHydrationDependencies);
export const userService = new UserService(firebaseUserDependencies, firebaseCoreServices);
export const organizationService = new OrganizationService(
    firebaseOrganizationDependencies,
    firebaseCoreServices,
);
export const promptService = new PromptService(firebasePromptDependencies, firebaseCoreServices);
export const replyService = new ReplyService(firebaseReplyDependencies, firebaseCoreServices);
export const feedService = new FeedService(firebaseCoreServices);
// Re-export RssService's own singleton for completeness. Core owns both the
// class and the singleton (it's a genuinely standalone service, no Firebase
// bindings). Routes that need it can import directly from here.
export const rssService = rssServiceSingleton;

/**
 * Firebase-wired StorageService. Not part of CoreServices (none of the core
 * services call it as a peer), so constructed directly via the factory.
 * Shape mirrors apps/web's StorageService export — `StorageService.uploadFile(...)`,
 * `StorageService.getSignedUrl(...)`, `StorageService.extractObjectPath(...)`.
 */
export const StorageService = makeStorageService(firebaseBlobStore);
