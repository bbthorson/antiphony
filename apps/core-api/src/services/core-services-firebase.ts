import { UserService } from '@vox-pop/core/services/users';
import type { CoreServices } from '@vox-pop/core/services/core-services';
import { firebaseUserDependencies } from './users-dependencies.js';

/**
 * Firebase-wired `CoreServices` binding for core-api.
 *
 * **PR #2 scope**: constructs `UserService` with its Firebase-backed deps so
 * `GET /api/v1/handles` works. Every other service (prompts, organizations,
 * replies, hydration, rss) is a throwing stub — the TS contract requires a
 * full `CoreServices` to construct `UserService`, but those methods aren't
 * reached by the handles endpoint. Each PR that ports a new endpoint wires
 * the services it actually needs.
 *
 * Note: no React `cache()` wrappers here (unlike apps/web's binding) —
 * core-api isn't an RSC runtime, so per-render dedup doesn't apply. Hono's
 * per-request lifecycle gives each request a fresh context; if in-request
 * caching becomes necessary later, introduce a request-scoped DataLoader
 * then.
 *
 * Module-load cycle note: apps/web's binding uses a lazy-singleton pattern
 * because of an RSC `cache()` cycle via `firebaseCoreServices → users → core-services`.
 * Core-api doesn't have that cycle (no cache wrappers) so eager
 * construction is safe. If we ever add intra-core-services dependencies
 * (e.g., a service that reads from another's CoreServices binding at
 * module-load), reintroduce the lazy pattern at that point.
 */

const notYetPorted = (method: string): never => {
    throw new Error(
        `[core-api core-services-firebase] ${method} is not yet ported. See apps/core-api/src/services/core-services-firebase.ts.`,
    );
};

export const firebaseCoreServices: CoreServices = {
    hydration: {
        hydratePrompt: () => notYetPorted('hydration.hydratePrompt'),
        hydrateReply: () => notYetPorted('hydration.hydrateReply'),
        hydrateRepliesWithRecipient: () => notYetPorted('hydration.hydrateRepliesWithRecipient'),
        hydrateOrganization: () => notYetPorted('hydration.hydrateOrganization'),
        hydrateOrganizations: () => notYetPorted('hydration.hydrateOrganizations'),
        hydrateMembers: () => notYetPorted('hydration.hydrateMembers'),
        hydrateInvite: () => notYetPorted('hydration.hydrateInvite'),
    },
    prompts: {
        getPromptsForUser: () => notYetPorted('prompts.getPromptsForUser'),
        getPromptsForOrgContext: () => notYetPorted('prompts.getPromptsForOrgContext'),
        getPromptRecord: () => notYetPorted('prompts.getPromptRecord'),
        getPromptRecordsByIds: () => notYetPorted('prompts.getPromptRecordsByIds'),
        createPrompt: () => notYetPorted('prompts.createPrompt'),
    },
    users: {
        getUserData: () => notYetPorted('users.getUserData'),
        getUserDataByUid: () => notYetPorted('users.getUserDataByUid'),
        getUsersByIds: () => notYetPorted('users.getUsersByIds'),
        ensureUserExists: () => notYetPorted('users.ensureUserExists'),
    },
    organizations: {
        getOrganizationBySlug: () => notYetPorted('organizations.getOrganizationBySlug'),
    },
    replies: {
        getRepliesForPrompts: () => notYetPorted('replies.getRepliesForPrompts'),
    },
    rss: {
        parseFeed: () => notYetPorted('rss.parseFeed'),
    },
};

/**
 * Wired `UserService` singleton. Constructed eagerly (no module cycle with
 * the CoreServices binding because no cache()/lazy deps inside core-api).
 *
 * When PR #3+ ports an endpoint that needs another service, add a similar
 * singleton (e.g., `promptService = new PromptService(firebasePromptDeps, firebaseCoreServices)`)
 * and wire it into `firebaseCoreServices.prompts`.
 */
export const userService = new UserService(firebaseUserDependencies, firebaseCoreServices);
