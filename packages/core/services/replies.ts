import { ReplyRecordSchema } from 'shared/types';
import type { ReplyView, ReplyRecord, ProfileView } from 'shared/types';
import { NotFoundError, ForbiddenError } from 'shared/errors';
import type { CoreServices } from './core-services';
import type { ReplyDependencies } from './replies-dependencies';

/**
 * ReplyService is the business-logic layer for replies: validation, hydration,
 * ownership enforcement, search. Data access is delegated to an injected
 * `ReplyDependencies` binding; peer-service access flows through the
 * injected `CoreServices` (Phase 2.5 DI container).
 *
 * Lives in `packages/core/` as of Task E.4. The Firebase-backed binding and
 * singleton construction live in `apps/web/src/services/replies.ts` as the
 * composition layer.
 */
export class ReplyService {
    /**
     * Both params required — core cannot import the Firebase-backed default
     * bindings. Composition lives in `apps/web/`.
     */
    constructor(
        private readonly deps: ReplyDependencies,
        private readonly services: CoreServices,
    ) {}

    async getRepliesForPrompt(
        userId: string,
        prompt: { id: string; authorId: string; status?: string },
        recipient: ProfileView | null,
        options?: { includeArchived?: boolean },
    ): Promise<ReplyView[]> {
        console.info(`[ReplyService] Fetching replies for prompt: ${prompt.id}`);

        const isAuthor = prompt.authorId === userId;

        if (prompt.status && prompt.status !== 'live' && !isAuthor) {
            console.info(`[ReplyService] Prompt ${prompt.id} is ${prompt.status}. Hiding replies from non-author.`);
            return [];
        }

        const authorId = prompt.authorId;
        if (!authorId) return [];

        if (!recipient || recipient.id !== authorId) {
            console.error('[ReplyService] Recipient provided does not match prompt author or is missing.');
            return [];
        }

        const records = await this.deps.queryByPromptId(prompt.id, {
            includeArchived: options?.includeArchived,
        });

        const validReplies = await this.services.hydration.hydrateRepliesWithRecipient(records, recipient, { includePrivateData: isAuthor });
        console.info(`[ReplyService] Found ${validReplies.length} replies for prompt: ${prompt.id}`);
        return validReplies;
    }

    /**
     * Batch fetch replies for multiple prompts.
     * Useful for aggregated views (e.g. People/CRM) to avoid N+1 queries.
     */
    async getRepliesForPrompts(
        promptIds: string[],
        recipient: ProfileView,
        options?: { includeArchived?: boolean },
    ): Promise<Map<string, ReplyView[]>> {
        if (promptIds.length === 0) return new Map();

        const allRecords = await this.deps.queryByPromptIds(promptIds, {
            includeArchived: options?.includeArchived,
        });

        // In CRM context, the recipient IS the author of these prompts, so we include private data.
        const hydrated = await this.services.hydration.hydrateRepliesWithRecipient(allRecords, recipient, { includePrivateData: true });

        const map = new Map<string, ReplyView[]>();
        hydrated.forEach(reply => {
            const pid = reply.record.promptId;
            if (!map.has(pid)) map.set(pid, []);
            map.get(pid)?.push(reply);
        });

        // Sort each group by createdAt desc (dep doesn't guarantee order for the `in` query).
        map.forEach(replies => {
            replies.sort((a, b) => b.record.createdAt.getTime() - a.record.createdAt.getTime());
        });

        return map;
    }

    /**
     * Updates the status of a reply. Only the prompt author can change reply status.
     */
    async updateReplyStatus(replyId: string, status: 'live' | 'archived' | 'deleted', authenticatedUid: string): Promise<void> {
        const reply = await this.deps.getReplyById(replyId);
        if (!reply) throw new NotFoundError(`Reply ${replyId} not found.`);

        const prompt = await this.services.prompts.getPromptRecord(reply.promptId);
        if (!prompt) throw new NotFoundError('Parent prompt not found.');
        if (prompt.authorId !== authenticatedUid) throw new ForbiddenError('You do not own the prompt for this reply.');

        await this.deps.updateReply(replyId, { status });
        console.info(`[ReplyService] Updated reply ${replyId} status to ${status}`);
    }

    /**
     * Bulk update status for multiple replies. Verifies ownership for all.
     */
    async bulkUpdateStatus(replyIds: string[], status: 'live' | 'archived' | 'deleted', authenticatedUid: string): Promise<void> {
        await this.assertOwnsAllReplies(replyIds, authenticatedUid);
        await this.deps.bulkUpdateReplies(replyIds, { status });
        console.info(`[ReplyService] Bulk updated ${replyIds.length} replies to status ${status}`);
    }

    /**
     * Bulk mark replies as read by adding uid to readBy array.
     */
    async bulkMarkRead(replyIds: string[], authenticatedUid: string): Promise<void> {
        await this.assertOwnsAllReplies(replyIds, authenticatedUid);
        await this.deps.bulkMarkRepliesRead(replyIds, authenticatedUid);
        console.info(`[ReplyService] Bulk marked ${replyIds.length} replies as read`);
    }

    /**
     * Ownership check spanning reply → prompt → author. Used by both bulk
     * status updates and bulk read-marking; kept in the service layer because
     * it orchestrates across services.
     */
    private async assertOwnsAllReplies(replyIds: string[], authenticatedUid: string): Promise<void> {
        const replies = await this.deps.getRepliesByIds(replyIds);
        const validReplies = replies.filter((r): r is ReplyRecord => r !== null);
        if (validReplies.length !== replyIds.length) {
            throw new NotFoundError('One or more replies not found.');
        }

        const promptIds = [...new Set(validReplies.map(r => r.promptId))];
        const prompts = await Promise.all(promptIds.map(id => this.services.prompts.getPromptRecord(id)));
        for (const prompt of prompts) {
            if (!prompt) throw new NotFoundError('Parent prompt not found.');
            if (prompt.authorId !== authenticatedUid) throw new ForbiddenError('You do not own all prompts for these replies.');
        }
    }

    /**
     * Search replies by transcription text across all user's prompts.
     */
    async searchReplies(userId: string, query: string, filters?: {
        promptId?: string;
        status?: 'live' | 'archived' | 'all';
        dateFrom?: Date;
        dateTo?: Date;
        readStatus?: 'read' | 'unread' | 'all';
    }): Promise<ReplyView[]> {
        const user = await this.services.users.getUserDataByUid(userId);
        if (!user) throw new NotFoundError('User not found.');

        const prompts = await this.services.prompts.getPromptsForUser(userId, 100, undefined, false);
        let promptIds = prompts.map(p => p.record.id);

        if (filters?.promptId) {
            promptIds = promptIds.filter(id => id === filters.promptId);
        }

        if (promptIds.length === 0) return [];

        const includeArchived = filters?.status === 'archived' || filters?.status === 'all';
        const repliesMap = await this.getRepliesForPrompts(promptIds, user, { includeArchived });
        let allReplies = Array.from(repliesMap.values()).flat();

        if (filters?.status === 'archived') {
            allReplies = allReplies.filter(r => r.record.status === 'archived');
        }

        const lowerQuery = query.toLowerCase();
        allReplies = allReplies.filter(r =>
            r.transcription?.toLowerCase().includes(lowerQuery) ||
            r.record.transcription?.toLowerCase().includes(lowerQuery)
        );

        if (filters?.dateFrom) {
            allReplies = allReplies.filter(r => r.record.createdAt >= filters.dateFrom!);
        }
        if (filters?.dateTo) {
            allReplies = allReplies.filter(r => r.record.createdAt <= filters.dateTo!);
        }

        if (filters?.readStatus === 'read') {
            allReplies = allReplies.filter(r => r.isRead);
        } else if (filters?.readStatus === 'unread') {
            allReplies = allReplies.filter(r => !r.isRead);
        }

        allReplies.sort((a, b) => b.record.createdAt.getTime() - a.record.createdAt.getTime());

        return allReplies;
    }

    getNewId(): string {
        return this.deps.newReplyId();
    }

    /**
     * Orchestrates the creation of a reply: ensures user profile exists,
     * validates the candidate record, then delegates the atomic write
     * (reply + prompt counter + activity) to the deps layer.
     */
    async createReplyTransaction(userId: string, input: { promptId: string; audioUrl: string }) {
        // 1. Ensure User Profile Exists.
        // If the user doesn't exist (e.g. phone auth in widget), create a stub user.
        await this.services.users.ensureUserExists(userId);

        // 2. Construct Candidate ReplyRecord.
        const replyId = this.deps.newReplyId();
        const now = this.deps.now();
        const candidateRecord = {
            id: replyId,
            promptId: input.promptId,
            authorId: userId,
            audioUrl: input.audioUrl,
            createdAt: now,
            status: 'live',
        };

        // 3. Validate Candidate against ReplyRecordSchema.
        const recordValidation = ReplyRecordSchema.safeParse(candidateRecord);
        if (!recordValidation.success) {
            const errorMap = recordValidation.error.flatten().fieldErrors;
            throw new Error(`Internal Validation Error: Invalid ReplyRecord constructed. ${JSON.stringify(errorMap)}`);
        }
        const validRecord = recordValidation.data as ReplyRecord;

        // 4. Atomic write: save record + increment prompt count + create activity.
        const activity = validRecord.authorId
            ? {
                id: this.deps.newActivityId(),
                type: 'Reply' as const,
                actor: validRecord.authorId,
                object: validRecord,
                createdAt: validRecord.createdAt,
            }
            : null;
        await this.deps.createReplyWithCounterIncrement(validRecord, activity);

        // 5. AI enrichment is handled by Cloud Functions (single source of
        // truth), so no explicit trigger is fired here.

        return this.services.hydration.hydrateReply(validRecord);
    }

    async getReplyRecord(replyId: string): Promise<ReplyRecord | null> {
        return this.deps.getReplyById(replyId);
    }

    /**
     * Updates the private notes for a reply.
     */
    async updateReplyNotes(replyId: string, notes: string) {
        await this.deps.updateReply(replyId, { notes });
    }
}
