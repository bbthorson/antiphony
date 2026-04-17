import type {
    PromptView,
    ProfileView,
    OrganizationView,
    ReplyView,
} from 'shared/types';

/**
 * Inlined here to keep `packages/core/` free of imports into `apps/web/`.
 * When `rss.ts` moves to core in a later Task E step, collapse back to a
 * clean import — or promote this type to `packages/shared/types` if it
 * proves useful beyond the feeds surface.
 */
export interface RssSummary {
    title?: string;
    description?: string;
    image?: string;
    link?: string;
    items?: Array<{
        title?: string;
        link?: string;
        content?: string;
        pubDate?: string;
    }>;
    lastFetchedAt?: Date;
}

/**
 * CoreServices is the Phase 2.5 solution for service-to-service dependency
 * injection. Core-tier services (currently: `feeds.ts`; eventually hydration,
 * prompts, users, etc.) call into other core-tier services through narrow
 * contract interfaces rather than importing concrete singletons. This keeps
 * the Firebase transitive-dep graph out of core-destined files.
 *
 * See `specs/decoupling-migration.md` — "Task D" and "Phase 2.5".
 *
 * ## Why this file exists
 *
 * Before this abstraction, `feeds.ts` imported `promptService`, `userService`,
 * `organizationService`, `replyService`, `rssService` directly. Even though
 * `feeds.ts` has zero direct Firebase imports of its own, those imports
 * pulled in `@/services/*-dependencies.ts` modules, each of which imports
 * `firebase-admin` in its default binding. So `feeds.ts` was not
 * Firebase-free at the module-graph level, and moving it to `packages/core/`
 * would have dragged `firebase-admin` into core by transitivity.
 *
 * The contracts below are deliberately narrow — they only enumerate methods
 * core services actually call. Expand them when new callers need new
 * methods; do not mirror entire service surfaces speculatively.
 *
 * ## Concrete binding
 *
 * The Firebase-backed `CoreServices` implementation lives in
 * `core-services-firebase.ts`. Tests can construct their own `CoreServices`
 * objects with mock implementations; no mocking of `firebase-admin` or
 * `getAdminDb` is required.
 */

// --- Per-service contracts ---
//
// Each contract is a subset of the corresponding service class, chosen to
// minimize the "surface area" the core side depends on. When a core service
// starts calling a new method, expand the contract — don't reach past it
// back to the concrete class.

export interface PromptServiceContract {
    getPromptsForUser(
        userId: string,
        limit?: number,
        lastPromptId?: string,
        publicOnly?: boolean,
    ): Promise<PromptView[]>;

    getPromptsForOrgContext(
        orgId: string,
        limit?: number,
        lastPromptId?: string,
        publicOnly?: boolean,
    ): Promise<PromptView[]>;
}

export interface UserServiceContract {
    getUserData(handle: string): Promise<ProfileView | null>;
    getUserDataByUid(uid: string): Promise<ProfileView | null>;
    /**
     * Batch variant — used by hydration DataLoaders and batch enrichment.
     * When `includePrivateData` is set, the binding may also enrich lite
     * users (no handle) with phone numbers from the identity provider.
     */
    getUsersByIds(uids: string[], options?: { includePrivateData?: boolean }): Promise<ProfileView[]>;
}

export interface OrganizationServiceContract {
    getOrganizationBySlug(slug: string, currentUserId?: string): Promise<OrganizationView | null>;
}

export interface ReplyServiceContract {
    getRepliesForPrompts(
        promptIds: string[],
        recipient: ProfileView,
        options?: { includeArchived?: boolean },
    ): Promise<Map<string, ReplyView[]>>;
}

export interface RssServiceContract {
    parseFeed(url: string, limit?: number): Promise<RssSummary | null>;
}

// --- Aggregate ---

/**
 * The full dependency surface that core-tier services depend on for
 * cross-service calls. Passed into core service constructors.
 *
 * Naming: keyed by domain (`prompts`, `users`, …) rather than class name,
 * so tests can read like `services.users.getUserData(...)`.
 */
export interface CoreServices {
    prompts: PromptServiceContract;
    users: UserServiceContract;
    organizations: OrganizationServiceContract;
    replies: ReplyServiceContract;
    rss: RssServiceContract;
}
