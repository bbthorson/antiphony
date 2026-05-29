import { PromptView, PromptRecord } from 'shared/types';
import { z } from 'zod';
import type { CoreServices } from '../ports/core-services';
import type { PromptDependencies, PromptQueryOptions } from '../ports/prompts-dependencies';

const CreatePromptSchema = z.object({
    title: z.string().min(3, 'Title must be at least 3 characters long.'),
    description: z.string().optional(),
    audioUrl: z.string().url('Invalid audio URL.'),
    authorId: z.string().min(1, 'Author ID is required'),
    /** Organization context (null = personal) */
    orgId: z.string().nullable().optional(),
    /** User who created this prompt (legacy field, kept for backward compatibility) */
    createdBy: z.string().optional(),
});

export type CreatePromptInput = z.infer<typeof CreatePromptSchema>;

/**
 * PromptService is the business-logic layer for prompts: validation, hydration,
 * activity logging, cursor pagination. Data access is delegated to an injected
 * `PromptDependencies` binding; peer-service access flows through the injected
 * `CoreServices` (Phase 2.5 DI container).
 *
 * Lives in `packages/core/` as of Task E.4. The Firebase-backed binding and
 * singleton construction live in `apps/web/src/services/prompts.ts` as the
 * composition layer.
 */
export class PromptService {
    /**
     * Both params required — core cannot import the Firebase-backed default
     * bindings. Composition lives in `apps/web/`.
     */
    constructor(
        private readonly deps: PromptDependencies,
        private readonly services: CoreServices,
    ) {}

    /**
     * Fetches prompts for a user with pagination.
     */
    async getPromptsForUser(userId: string, limit: number = 20, lastPromptId?: string, publicOnly: boolean = false): Promise<PromptView[]> {
        console.info(`[PromptService] Fetching prompts for user: ${userId}, limit: ${limit}, lastPromptId: ${lastPromptId}, publicOnly: ${publicOnly}`);
        try {
            const options: PromptQueryOptions = {
                status: publicOnly ? 'live' : 'live-or-archived',
                limit,
                cursorPromptId: lastPromptId,
            };
            const documents = await this.deps.queryByAuthor(userId, options);

            // Fetch the author profile once and pass it to the hydrator.
            const authorProfile = await this.services.users.getUserDataByUid(userId);

            const prompts = await Promise.all(
                documents.map(async (doc) => {
                    try {
                        return await this.services.hydration.hydratePrompt(doc, authorProfile || undefined);
                    } catch (error) {
                        console.error(`[PromptService] Failed to hydrate prompt ${doc.id}:`, error);
                        return null;
                    }
                }),
            ).then(results => results.filter((p): p is PromptView => p !== null));

            console.info(`[PromptService] Found ${prompts.length} prompts for user: ${userId}`);
            return prompts;
        } catch (error) {
            console.error(`[PromptService] Error fetching prompts for user ${userId}:`, error);
            throw error;
        }
    }

    /**
     * Fetches prompts belonging to an organization context.
     * Each prompt may have a different author, so we don't pre-fetch a single author profile.
     * Instead, we rely on DataLoader batching in the hydration service for efficient author lookups.
     */
    async getPromptsForOrgContext(orgId: string, limit: number = 20, lastPromptId?: string, publicOnly: boolean = false): Promise<PromptView[]> {
        console.info(`[PromptService] Fetching prompts for org context: ${orgId}, limit: ${limit}`);
        try {
            const options: PromptQueryOptions = {
                status: publicOnly ? 'live' : 'live-or-archived',
                limit,
                cursorPromptId: lastPromptId,
            };
            const documents = await this.deps.queryByOrg(orgId, options);

            const prompts = await Promise.all(
                documents.map(async (doc) => {
                    try {
                        return await this.services.hydration.hydratePrompt(doc);
                    } catch (error) {
                        console.error(`[PromptService] Failed to hydrate prompt ${doc.id}:`, error);
                        return null;
                    }
                }),
            ).then(results => results.filter((p): p is PromptView => p !== null));

            console.info(`[PromptService] Found ${prompts.length} prompts for org: ${orgId}`);
            return prompts;
        } catch (error) {
            console.error(`[PromptService] Error fetching prompts for org ${orgId}:`, error);
            throw error;
        }
    }

    /**
     * Fetches a single prompt by its ID.
     */
    async getPromptData(promptId: string): Promise<PromptView | null> {
        try {
            const document = await this.deps.getDocumentById(promptId);
            if (!document) {
                console.warn(`[PromptService] Prompt data not found at prompts/${promptId}`);
                return null;
            }
            return await this.services.hydration.hydratePrompt(document);
        } catch (error) {
            console.error(`[PromptService] Error fetching prompt data for prompts/${promptId}:`, error);
            throw error;
        }
    }

    /**
     * Fetches a single prompt record by its ID.
     */
    async getPromptRecord(promptId: string): Promise<PromptRecord | null> {
        try {
            const record = await this.deps.getRecordById(promptId);
            if (!record) {
                console.warn(`[PromptService] Prompt record not found with id: ${promptId}`);
                return null;
            }
            return record;
        } catch (error) {
            console.error(`[PromptService] Error fetching prompt record for id ${promptId}:`, error);
            throw error;
        }
    }

    /**
     * Batch fetch of prompt records. Positionally aligned with the input;
     * `null` at indices where the prompt is missing. Used by bulk ownership
     * checks to avoid an N+1.
     */
    async getPromptRecordsByIds(promptIds: string[]): Promise<Array<PromptRecord | null>> {
        if (promptIds.length === 0) return [];
        try {
            return await this.deps.getRecordsByIds(promptIds);
        } catch (error) {
            console.error('[PromptService] Error in batch getPromptRecordsByIds:', error);
            throw error;
        }
    }

    /**
     * Validates input and creates a new prompt.
     * Business logic moved from API route to Service.
     */
    async validateAndCreatePrompt(input: CreatePromptInput) {
        const validation = CreatePromptSchema.safeParse(input);

        if (!validation.success) {
            const errorMap = validation.error.flatten().fieldErrors;
            throw new Error(`Validation failed: ${JSON.stringify(errorMap)}`);
        }

        return this.createPrompt(validation.data);
    }

    async createPrompt(promptData: Partial<PromptRecord>) {
        const id = promptData.id || this.deps.newPromptId();
        const now = this.deps.now();

        const finalData = {
            ...promptData,
            id,
            createdAt: promptData.createdAt || now,
            status: promptData.status || 'live',
            replyCount: 0,
        } as PromptRecord & { replyCount: number };

        await this.deps.savePrompt(finalData);

        // Log activity alongside prompt creation. Keeping this as separate
        // persistence calls (rather than a shared transaction) matches the
        // current behavior and keeps the dep interface minimal.
        if (finalData.authorId) {
            await this.deps.saveActivity({
                id: this.deps.newActivityId(),
                type: 'Create',
                actor: finalData.authorId,
                object: finalData,
                createdAt: now,
            });
        }

        return finalData;
    }

    /**
     * Updates the status of a prompt (e.g., 'live' -> 'archived').
     */
    async updatePromptStatus(promptId: string, status: 'live' | 'archived') {
        await this.deps.updatePrompt(promptId, { status });
    }

    /**
     * Updates a prompt with partial data.
     */
    async updatePrompt(promptId: string, updates: Partial<PromptRecord>) {
        await this.deps.updatePrompt(promptId, updates);
    }

    /**
     * Records the AT Protocol URI returned by the publisher onto the
     * prompt. Narrow wrapper around `updatePrompt` so the calling
     * endpoint exposes only this single field — matches the
     * `updatePromptStatus` shape.
     */
    async setPromptAtprotoUri(promptId: string, atprotoUri: string) {
        await this.deps.updatePrompt(promptId, { atprotoUri });
    }

    /**
     * Soft-deletes a prompt (status -> 'deleted').
     */
    async deletePrompt(promptId: string) {
        await this.deps.updatePrompt(promptId, { status: 'deleted' as PromptRecord['status'] });
    }
}
