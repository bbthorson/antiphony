import type { PromptDocument } from 'shared/types/storage';
import type { ProfileView, ReplyEnrichmentRecord } from 'shared/types';

/**
 * HydrationDependencies is the portable interface that HydrationService
 * uses to access the underlying data store. Lives in `packages/core/`
 * alongside the class; the Firestore-backed default implementation lives
 * in `apps/web/src/services/hydration-dependencies.ts` as the binding.
 *
 * Alternative implementations (Postgres, in-memory for tests) can be
 * plugged in by providing an object conforming to this interface.
 *
 * **Batching contract:** `loadUser` and `loadPrompt` are expected to batch
 * requests within a single render pass (N+1 prevention). The Firebase
 * implementation uses `DataLoader` wrapped in React's `cache()` for this;
 * alternative implementations must preserve equivalent per-request batching.
 *
 * See `specs/decoupling-migration.md` — Task E.3.
 */
export interface HydrationDependencies {
    /** Loads a single user profile by UID. Batched per render pass. */
    loadUser(id: string): Promise<ProfileView | null>;

    /** Loads a single prompt document (record + computed fields). Batched per render pass. */
    loadPrompt(id: string): Promise<PromptDocument | null>;

    /** Total member count for an organization. */
    countOrgMembers(orgId: string): Promise<number>;

    /** Role of a specific user in an org, or undefined if not a member. */
    getOrgMemberRole(orgId: string, userId: string): Promise<'owner' | 'admin' | 'member' | undefined>;

    /** Human-readable org name by ID, or null if missing. */
    getOrgName(orgId: string): Promise<string | null>;

    /**
     * Batch-fetch user profiles, with option to include private data. Separate
     * from `loadUser` because private-data fetches must not share a cache with
     * public-data fetches.
     */
    getUsersByIds(ids: string[], options?: { includePrivateData?: boolean }): Promise<ProfileView[]>;

    /**
     * Batch-fetch reply enrichment records (notes, etc.). Only called when
     * hydrating with `includePrivateData: true` — non-authors never see
     * enrichment data. Missing replies are absent from the returned Map.
     * See specs/data-separation.md § 3 for the namespace strategy.
     */
    getReplyEnrichmentsByIds(replyIds: string[]): Promise<Map<string, ReplyEnrichmentRecord>>;
}
