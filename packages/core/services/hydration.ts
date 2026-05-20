import { ReplyRecord, ReplyView, ProfileView, PromptView, PromptRecordSchema } from 'shared/types';
import { OrganizationRecord, OrganizationMemberRecord, OrgInviteRecord } from 'shared/types/records';
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

    /**
     * Hydrates multiple PromptDocuments into PromptViews.
     * Batches author lookups via the dependency's loader for N+1 prevention.
     */
    async hydratePrompts(documents: PromptDocument[], prefetchedAuthor?: ProfileView): Promise<PromptView[]> {
        if (!documents.length) return [];
        return Promise.all(documents.map(doc => this.hydratePrompt(doc, prefetchedAuthor)));
    }

    // --- Reply Hydration ---

    /**
     * Hydrates a single ReplyRecord into a ReplyView using the injected loaders.
     *
     * `preloadedNotes` — viewer-private notes lifted from the
     * `enrichments/replies/{id}` namespace. Pass when the caller has already
     * batch-fetched enrichments (the list-hydration paths do this for the
     * prompt author). Leave undefined for non-author viewers; the field
     * stays undefined on the view and is also defensively stripped by
     * `toReplyViewPublic`.
     */
    async hydrateReply(
        record: ReplyRecord,
        knownRecipient?: ProfileView,
        preloadedAuthor?: ProfileView | null,
        preloadedNotes?: string,
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
            // AI Enrichment — lift from record to view
            transcription: record.transcription,
            sentiment: record.sentiment,
            energyLevel: record.energyLevel,
            engagementScore: record.engagementScore,
            aiStatus: record.aiStatus,
            aiError: record.aiError,
            aiSummary: record.aiSummary,
            aiLabels: record.aiLabels,
            // CRM enrichment — populated only when the caller has author privileges
            notes: preloadedNotes,
        };
    }

    /**
     * Batch-loads CRM enrichment notes for a set of replies. Returns a Map
     * keyed by replyId — replies with no enrichment doc (or no `notes`
     * field) are simply absent. Shared by `hydrateReplies` and
     * `hydrateRepliesWithRecipient`; caller guards on `includePrivateData`
     * before invoking.
     */
    private async fetchEnrichmentNotes(records: ReplyRecord[]): Promise<Map<string, string>> {
        const enrichments = await this.deps.getReplyEnrichmentsByIds(records.map(r => r.id));
        const notesMap = new Map<string, string>();
        for (const [replyId, enrichment] of enrichments) {
            if (enrichment.notes !== undefined) notesMap.set(replyId, enrichment.notes);
        }
        return notesMap;
    }

    /**
     * Helper to preload resources needed for reply hydration.
     * Deduplicates author IDs to prevent database limits.
     */
    private async preloadHydrationResources(
        records: ReplyRecord[],
        options?: { includePrivateData?: boolean },
    ): Promise<{
        authorMap: Map<string, ProfileView>;
        notesMap?: Map<string, string>;
    }> {
        if (!records.length) {
            return { authorMap: new Map() };
        }

        const uniqueAuthorIds = Array.from(new Set(records.map(r => r.authorId)));
        const profiles = await this.deps.getUsersByIds(uniqueAuthorIds, {
            includePrivateData: !!options?.includePrivateData,
        });
        const authorMap = new Map(profiles.map(p => [p.id, p]));

        let notesMap: Map<string, string> | undefined;
        if (options?.includePrivateData) {
            notesMap = await this.fetchEnrichmentNotes(records);
        }

        return { authorMap, notesMap };
    }

    /**
     * Hydrates a list of ReplyRecords into ReplyViews.
     */
    async hydrateReplies(records: ReplyRecord[], options?: { includePrivateData?: boolean }): Promise<ReplyView[]> {
        if (!records.length) return [];

        const { authorMap, notesMap } = await this.preloadHydrationResources(records, options);

        const views = await Promise.all(records.map(r => {
            const author = authorMap.get(r.authorId) || null;
            const notes = notesMap?.get(r.id);
            return this.hydrateReply(r, undefined, author, notes);
        }));
        return views.filter((v): v is ReplyView => v !== null);
    }

    async hydrateRepliesWithRecipient(
        records: ReplyRecord[],
        recipient: ProfileView,
        options?: { includePrivateData?: boolean },
    ): Promise<ReplyView[]> {
        if (!records.length) return [];

        const { authorMap, notesMap } = await this.preloadHydrationResources(records, options);

        const views = await Promise.all(records.map(r => {
            const author = authorMap.get(r.authorId) || null;
            const notes = notesMap?.get(r.id);
            return this.hydrateReply(r, recipient, author, notes);
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

    async hydrateInvites(records: OrgInviteRecord[], prefetchedOrgName?: string): Promise<OrgInviteView[]> {
        return Promise.all(records.map(r => this.hydrateInvite(r, prefetchedOrgName)));
    }
}
