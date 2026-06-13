import { ReplyRecord, PromptRecordSchema, ReplyEnrichmentRecord } from 'shared/types/records';
import { ReplyView, ProfileView, PromptView } from 'shared/types/views';
import {
    OrganizationRecord,
    OrganizationMemberRecord,
    OrgInviteRecord,
} from 'shared/types/records';
import { OrganizationView, OrganizationMemberView, OrgInviteView } from 'shared/types/views';
import { PromptDocument } from 'shared/types/storage';
import { NotFoundError } from 'shared/errors';
import type { HydrationDependencies } from '../ports/hydration-dependencies';

/**
 * HydrationService converts raw Records and Documents into hydrated Views
 * (Record + author profile + computed fields) for the UI.
 *
 * Data access is delegated to a `HydrationDependencies` interface that is
 * injected at construction. Lives in `packages/core/` as of Task E.3. The
 * Firestore-backed default binding and the `hydrationService` singleton live
 * in `apps/web/src/services/hydration.ts` as the composition layer.
 *
 * Alternative implementations (Postgres, in-memory for tests) can be supplied
 * without touching any code in this file.
 */
export class HydrationService {
    /**
     * `deps` is intentionally required (no default) — `packages/core/` cannot
     * import the Firebase-backed binding without violating the Firebase-free
     * invariant. Composition lives in `apps/web/`.
     */
    constructor(private readonly deps: HydrationDependencies) {}

    // --- Prompt Hydration ---

    /**
     * Hydrates a PromptDocument into a PromptView.
     * Uses the injected dependency's batched user loader for author fetching.
     *
     * @param document - The PromptDocument to hydrate (includes computed fields like replyCount).
     * @param prefetchedAuthor - Optional pre-fetched author profile to avoid redundant lookups.
     */
    async hydratePrompt(document: PromptDocument, prefetchedAuthor?: ProfileView): Promise<PromptView> {
        let authorView: ProfileView;

        if (prefetchedAuthor && prefetchedAuthor.id === document.authorId) {
            authorView = prefetchedAuthor;
        } else {
            const loaded = await this.deps.loadUser(document.authorId);
            if (!loaded) {
                throw new NotFoundError(`Author not found for prompt: ${document.id}`);
            }
            authorView = loaded;
        }

        // Strip computed fields to get the pure Record
        const record = PromptRecordSchema.parse(document);

        const sentimentCounts = document.sentimentCounts;
        const avgEngagementScore = document.engagementScoreCount > 0
            ? document.engagementScoreSum / document.engagementScoreCount
            : null;

        return {
            record,
            author: authorView,
            replyCount: document.replyCount,
            lastReplyAt: document.lastReplyAt,
            likeCount: 0,
            visibility: record.status === 'live' ? 'public' : 'archived',
            analytics: {
                views: 0,
                listens: 0,
                avgEngagementScore,
                sentimentBreakdown: sentimentCounts,
            },
            // AI Enrichment Fields
            aiStatus: record.aiStatus,
            aiError: record.aiError,
            aiSummary: record.aiSummary,
            aiLabels: record.aiLabels,
            transcription: record.transcription,
        };
    }

    // --- Reply Hydration ---

    /**
     * Hydrates a single ReplyRecord into a ReplyView using the injected loaders.
     *
     * `preloadedEnrichment` — the reply's enrichment record from the
     * `enrichments/replies/items/{id}` namespace. Pass when the caller
     * has already batch-fetched enrichments (the list-hydration paths
     * do this for the prompt author). Leave undefined for non-author
     * viewers; the lifted private fields (notes, AI cluster,
     * socialVideo*) stay undefined on the view and are also defensively
     * stripped by `toReplyViewPublic`.
     *
     * AI-enrichment source: the lifted fields (transcription, sentiment,
     * AI cluster, voice isolation, social video) come from the enrichment
     * doc only — Stage 4 of the AI-enrichment split removed them from
     * the canonical `ReplyRecord`. See `specs/ai-enrichment-split.md`
     * § 3.
     */
    async hydrateReply(
        record: ReplyRecord,
        knownRecipient?: ProfileView,
        preloadedAuthor?: ProfileView | null,
        preloadedEnrichment?: ReplyEnrichmentRecord,
    ): Promise<ReplyView | null> {
        let author: ProfileView | null | undefined = preloadedAuthor;
        if (author === undefined) {
            author = await this.deps.loadUser(record.authorId);
        }

        // Fallback for missing author — synthetic stub so callers still render
        const now = new Date();
        const safeAuthor = author || {
            id: record.authorId,
            handle: 'Unknown User',
            username: 'unknown',
            displayName: 'Unknown User',
            photoUrl: null,
            bio: null,
            stats: { followers: 0, following: 0, prompts: 0 },
            unreadReplyCount: 0,
            newReplierCount: 0,
            createdAt: now,
            updatedAt: now,
        } as unknown as ProfileView;

        let recipient = knownRecipient;
        if (!recipient) {
            const prompt = await this.deps.loadPrompt(record.promptId);
            if (!prompt) return null; // Orphaned reply
            recipient = await this.deps.loadUser(prompt.authorId) || undefined;
        }

        if (!recipient) return null; // Missing recipient

        return {
            record,
            author: safeAuthor,
            recipient,
            isRead: false,
            isDeleted: false,
            readBy: [],
            // Audio duration (seconds) — populated by the transcribeAndScore trigger
            duration: record.audioDurationSec,
            // AI enrichment — sole source is the enrichment doc since
            // Stage 4 stripped these off the canonical ReplyRecord.
            transcription: preloadedEnrichment?.transcription,
            sentiment: preloadedEnrichment?.sentiment,
            energyLevel: preloadedEnrichment?.energyLevel,
            engagementScore: preloadedEnrichment?.engagementScore,
            aiStatus: preloadedEnrichment?.aiStatus,
            aiError: preloadedEnrichment?.aiError,
            aiSummary: preloadedEnrichment?.aiSummary,
            aiLabels: preloadedEnrichment?.aiLabels,
            // Voice isolation (paid tier)
            enhancedAudioUrl: preloadedEnrichment?.enhancedAudioUrl,
            enhancedStoragePath: preloadedEnrichment?.enhancedStoragePath,
            // Social-share video (paid tier, creator-only)
            socialVideoUrl: preloadedEnrichment?.socialVideoUrl,
            socialVideoStoragePath: preloadedEnrichment?.socialVideoStoragePath,
            socialVideoStatus: preloadedEnrichment?.socialVideoStatus,
            socialVideoError: preloadedEnrichment?.socialVideoError,
            socialVideoSourceAudio: preloadedEnrichment?.socialVideoSourceAudio,
            // CRM enrichment — populated only when the caller has author privileges
            notes: preloadedEnrichment?.notes,
        };
    }

    /**
     * Batch-loads full enrichment records for a set of replies. Returns a
     * Map keyed by replyId — replies with no enrichment doc are simply
     * absent. Shared by `hydrateReplies` and `hydrateRepliesWithRecipient`.
     *
     * Pulls the full enrichment record (not just `notes`) because — post
     * Stage 4 of the AI-enrichment split — the enrichment doc is the sole
     * source for the lifted AI / voice-isolation / social-video fields,
     * including the public ones (`transcription`, `enhancedAudioUrl`).
     * `toReplyViewPublic` strips the private subset on projection. See
     * `specs/ai-enrichment-split.md` § 3.
     */
    private async fetchEnrichmentsForReplies(
        records: ReplyRecord[],
    ): Promise<Map<string, ReplyEnrichmentRecord>> {
        return await this.deps.getReplyEnrichmentsByIds(records.map(r => r.id));
    }

    /**
     * Helper to preload resources needed for reply hydration.
     * Deduplicates author IDs to prevent database limits.
     *
     * Enrichments are always fetched (regardless of `includePrivateData`)
     * because the public lifted fields (`transcription`,
     * `enhancedAudioUrl`) live there post Stage 4. The private subset
     * (notes, sentiment, engagementScore, social-video URL, …) is
     * stripped on projection by `toReplyViewPublic`.
     */
    private async preloadHydrationResources(
        records: ReplyRecord[],
        options?: { includePrivateData?: boolean },
    ): Promise<{
        authorMap: Map<string, ProfileView>;
        enrichmentsMap?: Map<string, ReplyEnrichmentRecord>;
    }> {
        if (!records.length) {
            return { authorMap: new Map() };
        }

        const uniqueAuthorIds = Array.from(new Set(records.map(r => r.authorId)));
        const [profiles, enrichmentsMap] = await Promise.all([
            this.deps.getUsersByIds(uniqueAuthorIds, {
                includePrivateData: !!options?.includePrivateData,
            }),
            this.fetchEnrichmentsForReplies(records),
        ]);
        const authorMap = new Map(profiles.map(p => [p.id, p]));

        return { authorMap, enrichmentsMap };
    }

    /**
     * Hydrates a list of ReplyRecords into ReplyViews.
     */
    async hydrateReplies(records: ReplyRecord[], options?: { includePrivateData?: boolean }): Promise<ReplyView[]> {
        if (!records.length) return [];

        const { authorMap, enrichmentsMap } = await this.preloadHydrationResources(records, options);

        const views = await Promise.all(records.map(r => {
            const author = authorMap.get(r.authorId) || null;
            const enrichment = enrichmentsMap?.get(r.id);
            return this.hydrateReply(r, undefined, author, enrichment);
        }));
        return views.filter((v): v is ReplyView => v !== null);
    }

    async hydrateRepliesWithRecipient(
        records: ReplyRecord[],
        recipient: ProfileView,
        options?: { includePrivateData?: boolean },
    ): Promise<ReplyView[]> {
        if (!records.length) return [];

        const { authorMap, enrichmentsMap } = await this.preloadHydrationResources(records, options);

        const views = await Promise.all(records.map(r => {
            const author = authorMap.get(r.authorId) || null;
            const enrichment = enrichmentsMap?.get(r.id);
            return this.hydrateReply(r, recipient, author, enrichment);
        }));
        return views.filter((v): v is ReplyView => v !== null);
    }

    // --- Organization Hydration ---

    async hydrateOrganization(record: OrganizationRecord, currentUserRole?: 'owner' | 'admin' | 'member'): Promise<OrganizationView> {
        const memberCount = await this.deps.countOrgMembers(record.id);

        return {
            record,
            memberCount,
            currentUserRole,
        };
    }

    async hydrateOrganizations(records: OrganizationRecord[], currentUserId?: string): Promise<OrganizationView[]> {
        if (!records.length) return [];
        return Promise.all(records.map(async (r) => {
            let role: 'owner' | 'admin' | 'member' | undefined = undefined;
            if (currentUserId) {
                role = await this.deps.getOrgMemberRole(r.id, currentUserId);
            }
            return this.hydrateOrganization(r, role);
        }));
    }

    // --- Member Hydration ---

    async hydrateMember(record: OrganizationMemberRecord): Promise<OrganizationMemberView> {
        const loaded = await this.deps.loadUser(record.userId);
        if (!loaded) throw new NotFoundError(`User profile not found for member ${record.userId}`);

        return {
            record,
            profile: loaded,
        };
    }

    async hydrateMembers(records: OrganizationMemberRecord[]): Promise<OrganizationMemberView[]> {
        return Promise.all(records.map(r => this.hydrateMember(r)));
    }

    // --- Invite Hydration ---

    async hydrateInvite(record: OrgInviteRecord, prefetchedOrgName?: string): Promise<OrgInviteView> {
        const inviterProfile = await this.deps.loadUser(record.invitedBy);

        let orgName: string = prefetchedOrgName || '';
        if (!orgName) {
            const loaded = await this.deps.getOrgName(record.orgId);
            orgName = loaded || 'Unknown Organization';
        }

        return {
            record,
            inviterName: inviterProfile?.displayName || inviterProfile?.handle || 'Unknown User',
            orgName,
        };
    }

}
