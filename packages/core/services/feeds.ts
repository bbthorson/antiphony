import {
    type Replier,
    type EnrichedReplier,
    type PromptWithReplies,
    type ProfileViewBasic,
    ProfileView,
    toProfileViewBasic,
    toPromptViewPublic,
    toReplyViewPublic,
    type PromptView,
    type OrganizationView,
    type HandleResolution,
} from 'shared/types/views';
import type { CoreServices, RssSummary } from '../ports/core-services';
import { type Logger, defaultLogger } from '../ports/logger';

/** Re-exported from shared/types so external callers can keep the existing import path. */
export type { HandleResolution };

/**
 * FeedService composes prompts, users, organizations, replies, and RSS feeds
 * into the shapes consumed by the dashboard, people list, and public profile
 * pages. It has no data access of its own — every cross-service call flows
 * through the injected `CoreServices` contract (Phase 2.5 DI container).
 *
 * This is the first service physically living in `packages/core/`. The
 * corresponding `apps/web/src/services/feeds.ts` file handles Firebase-binding
 * composition: constructing the `feedService` singleton and wrapping hot
 * entry points with React `cache()` for RSC-level dedup.
 *
 * See `specs/decoupling-migration.md` — Task E.1.
 */
export class FeedService {
    constructor(
        private readonly services: CoreServices,
        private readonly logger: Logger = defaultLogger,
    ) {}

    /**
     * Fetches a paginated feed for a user, including prompts and replies.
     * Handles visibility (public vs private) based on the viewer.
     */
    async getUserFeed(
        targetUserOrId: string | ProfileView,
        viewerId: string | null,
        limit: number = 20,
        lastPromptId?: string
    ) {
        let targetUser: ProfileView | null;
        if (typeof targetUserOrId === 'string') {
            targetUser = await this.services.users.getUserDataByUid(targetUserOrId);
        } else {
            targetUser = targetUserOrId;
        }

        if (!targetUser) return null;

        const isOwner = viewerId === targetUser.id;
        const publicOnly = !isOwner;

        const prompts = await this.services.prompts.getPromptsForUser(targetUser.id, limit, lastPromptId, publicOnly);

        // Replies are fetched by the client on demand. The promptsWithReplies
        // shape is preserved for backward compatibility; replies is always [].
        const promptsWithReplies: PromptWithReplies[] = prompts.map((prompt) => {
            return { ...prompt, replies: [] };
        });

        // Repliers calculation depends on eagerly-fetched replies, which this
        // method no longer does — returned empty so consumers handle gracefully.
        const repliers: Replier[] = [];

        return {
            user: targetUser,
            promptsWithReplies,
            repliers,
            lastDocId: prompts.length > 0 ? prompts[prompts.length - 1].record.id : null
        };
    }

    async getUserProfileData(handle: string) {
        if (!handle || typeof handle !== 'string' || handle.length < 1) {
            this.logger.error({ handle }, '[FeedService] Invalid handle parameter');
            return null;
        }

        const profileUser = await this.services.users.getUserData(handle);
        if (!profileUser) {
            return null;
        }

        const feedData = await this.getUserFeed(profileUser.id, null, 100);
        if (!feedData) return null;

        return {
            // Public profile page — strip PII/admin fields. `toProfileViewBasic`
            // also enforces the `showBlueskyPublicly` opt-in for the AT Proto link.
            profileUser: toProfileViewBasic(feedData.user),
            // Each prompt's nested `author` is the wide admin profile (prefetched
            // by getPromptsForUser via getUserDataByUid), so it carries the
            // owner's PII. Project every prompt — and its replies — through the
            // public projections before serializing to anonymous callers.
            allPromptsWithReplies: feedData.promptsWithReplies.map((pwr) => ({
                ...toPromptViewPublic(pwr),
                replies: pwr.replies.map(toReplyViewPublic),
            })),
            repliers: feedData.repliers,
        };
    }

    /**
     * Calculates enriched repliers with full profile data from reply authors.
     */
    calculateEnrichedRepliersFromPrompts(promptsWithReplies: PromptWithReplies[]): EnrichedReplier[] {
        const repliersMap = new Map<string, { profile: ProfileViewBasic; phoneNumber?: string; lastReplyDate: Date; firstReplyAt: Date; totalReplies: number }>();

        for (const prompt of promptsWithReplies) {
            for (const reply of prompt.replies) {
                const authorId = reply.author?.id;
                if (!authorId) continue;

                const replyDate = new Date(reply.record.createdAt);
                const existing = repliersMap.get(authorId);

                if (existing) {
                    existing.totalReplies += 1;
                    if (replyDate > existing.lastReplyDate) existing.lastReplyDate = replyDate;
                    if (replyDate < existing.firstReplyAt) existing.firstReplyAt = replyDate;
                } else {
                    // Phone number is hydrated for lite users via includePrivateData.
                    const authorWithPhone = reply.author as ProfileViewBasic & { phoneNumber?: string };
                    repliersMap.set(authorId, {
                        profile: {
                            id: reply.author.id,
                            handle: reply.author.handle,
                            displayName: reply.author.displayName,
                            avatarUrl: reply.author.avatarUrl,
                            bio: reply.author.bio,
                            createdAt: reply.author.createdAt,
                        },
                        phoneNumber: authorWithPhone.phoneNumber || undefined,
                        lastReplyDate: replyDate,
                        firstReplyAt: replyDate,
                        totalReplies: 1,
                    });
                }
            }
        }

        return Array.from(repliersMap.values())
            .sort((a, b) => b.lastReplyDate.getTime() - a.lastReplyDate.getTime())
            .map(r => ({
                profile: r.profile,
                totalReplies: r.totalReplies,
                lastReplyDate: r.lastReplyDate.toISOString(),
                firstReplyAt: r.firstReplyAt.toISOString(),
                phoneNumber: r.phoneNumber,
            }));
    }

    /**
     * Lightweight people list: returns only enriched repliers (no full reply/prompt payloads).
     * Used by the people list panel for fast initial load.
     * @param orgId - If provided, scopes to prompts in this org context.
     */
    async getPeopleList(userId: string, orgId?: string | null): Promise<EnrichedReplier[]> {
        const [user, prompts] = await Promise.all([
            this.services.users.getUserDataByUid(userId),
            orgId
                ? this.services.prompts.getPromptsForOrgContext(orgId, 100, undefined, false)
                : this.services.prompts.getPromptsForUser(userId, 100, undefined, false),
        ]);
        if (!user) return [];

        const promptIds = prompts.map(p => p.record.id);
        const repliesMap = await this.services.replies.getRepliesForPrompts(promptIds, user);

        const promptsWithReplies: PromptWithReplies[] = prompts.map((prompt) => {
            const replies = repliesMap.get(prompt.record.id) || [];
            return { ...prompt, replies };
        });

        return this.calculateEnrichedRepliersFromPrompts(promptsWithReplies);
    }

    /**
     * Resolves a handle to either a user profile or an organization.
     * Tries users first (preserving existing behavior), then falls back to org slugs.
     */
    async resolveHandle(handle: string): Promise<HandleResolution | null> {
        const user = await this.services.users.getUserData(handle);
        if (user) {
            // Public endpoint — project to the basic shape so PII never leaks.
            return { type: 'user', profile: toProfileViewBasic(user) };
        }

        const org = await this.services.organizations.getOrganizationBySlug(handle);
        if (org) {
            return { type: 'org', org };
        }

        return null;
    }

    /**
     * Fetches public data for an organization profile page.
     * Includes org details, prompts in the org context, and RSS summary if available.
     */
    async getOrgProfileData(slug: string): Promise<{
        org: OrganizationView;
        prompts: PromptView[];
        rssSummary: RssSummary | null;
    } | null> {
        const org = await this.services.organizations.getOrganizationBySlug(slug);
        if (!org) return null;

        const [prompts, rssSummary] = await Promise.all([
            this.services.prompts.getPromptsForOrgContext(org.record.id, 100, undefined, true),
            org.record.rssFeedUrl
                ? this.services.rss.parseFeed(org.record.rssFeedUrl, 20)
                : Promise.resolve(null),
        ]);

        return { org, prompts, rssSummary };
    }
}
