import { UserService } from '@vox-pop/core/services/users';
import { OrganizationService } from '@vox-pop/core/services/organizations';
import { HydrationService } from '@vox-pop/core/services/hydration';
import { FeedService } from '@vox-pop/core/services/feeds';
import type { CoreServices } from '@vox-pop/core/services/core-services';
import { firebaseUserDependencies } from './users-dependencies.js';
import { firebaseOrganizationDependencies } from './organizations-dependencies.js';
import { firebaseHydrationDependencies } from './hydration-dependencies.js';

/**
 * Firebase-wired `CoreServices` binding for core-api.
 *
 * **Scope as of this PR**:
 *   - `UserService` — fully constructed (getUserData path implemented in deps).
 *   - `HydrationService` — constructed; only `hydrateOrganization` + its
 *     transitive `countOrgMembers` dep is implemented. Other hydrate methods
 *     throw until their endpoints port.
 *   - `OrganizationService` — constructed; only `getOrganizationBySlug` is
 *     reachable (the `resolve` endpoint's org fallback).
 *   - `PromptService`, `ReplyService`, `RssService` — not wired yet; the
 *     CoreServices binding for each is a throwing stub. Wiring happens as
 *     endpoints need them (prompts endpoints in PR #4).
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
        getPromptsForUser: () => notYetPorted('prompts.getPromptsForUser'),
        getPromptsForOrgContext: () => notYetPorted('prompts.getPromptsForOrgContext'),
        getPromptRecord: () => notYetPorted('prompts.getPromptRecord'),
        getPromptRecordsByIds: () => notYetPorted('prompts.getPromptRecordsByIds'),
        createPrompt: () => notYetPorted('prompts.createPrompt'),
    },
    users: {
        getUserData: (handle: string) => userService.getUserData(handle),
        getUserDataByUid: (uid: string) => userService.getUserDataByUid(uid),
        getUsersByIds: () => notYetPorted('users.getUsersByIds'),
        ensureUserExists: () => notYetPorted('users.ensureUserExists'),
    },
    organizations: {
        getOrganizationBySlug: (slug: string, currentUserId?: string) =>
            organizationService.getOrganizationBySlug(slug, currentUserId),
    },
    replies: {
        getRepliesForPrompts: () => notYetPorted('replies.getRepliesForPrompts'),
    },
    rss: {
        parseFeed: () => notYetPorted('rss.parseFeed'),
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
export const feedService = new FeedService(firebaseCoreServices);
