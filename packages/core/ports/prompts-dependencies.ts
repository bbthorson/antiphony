import type { PromptDocument } from 'shared/types/storage';
import type { PromptRecord } from 'shared/types';

/**
 * PromptDependencies is the portable interface that PromptService uses to
 * access the underlying data store. Lives in `packages/core/` alongside the
 * class; the Firestore-backed default implementation lives in
 * `apps/web/src/services/prompts-dependencies.ts` as the binding.
 */

export interface PromptQueryOptions {
    /**
     * Status filter:
     *  - `'live'` returns only live prompts (public-facing)
     *  - `'live-or-archived'` (default) excludes deleted prompts
     */
    status?: 'live' | 'live-or-archived';
    /** Page size. Default 20. */
    limit?: number;
    /** Cursor — prompt ID to start after (exclusive). */
    cursorPromptId?: string;
}

/**
 * Activity records are written alongside certain prompt operations (e.g. a
 * `Create` activity when a prompt is created). Kept narrow here because the
 * activity feature is still nascent; if/when Activities become their own
 * service, this type moves with them.
 */
export interface ActivityRecord {
    id: string;
    type: 'Create';
    actor: string;
    object: unknown;
    createdAt: Date;
}

export interface PromptDependencies {
    /** Query prompts by author, with cursor pagination. Invalid documents are skipped with a log. */
    queryByAuthor(authorId: string, options?: PromptQueryOptions): Promise<PromptDocument[]>;

    /** Query prompts in an organization context, with cursor pagination. */
    queryByOrg(orgId: string, options?: PromptQueryOptions): Promise<PromptDocument[]>;

    /** Fetch a single prompt document (record + computed fields) by ID, or null if missing. Throws on schema mismatch. */
    getDocumentById(promptId: string): Promise<PromptDocument | null>;

    /** Fetch a pure PromptRecord by ID (no computed fields), or null if missing. */
    getRecordById(promptId: string): Promise<PromptRecord | null>;

    /**
     * Batch fetch PromptRecords by ID. Result is positionally aligned with
     * the input — `null` at indices where the prompt is missing or fails
     * schema validation.
     */
    getRecordsByIds(promptIds: string[]): Promise<Array<PromptRecord | null>>;

    /** Generate a new unique prompt ID without creating the document. */
    newPromptId(): string;

    /** Persist a prompt record (upsert). */
    savePrompt(record: PromptRecord & { replyCount: number }): Promise<void>;

    /** Apply a partial update to an existing prompt. Fails if the prompt doesn't exist. */
    updatePrompt(promptId: string, updates: Partial<PromptRecord>): Promise<void>;

    /** Generate a new unique activity ID. */
    newActivityId(): string;

    /** Persist an activity record. */
    saveActivity(activity: ActivityRecord): Promise<void>;

    /**
     * Current server time as a `Date`. Service code uses `Date` uniformly; the
     * implementation converts to whatever the storage layer requires
     * (Firestore accepts `Date` on writes and stores as `Timestamp`).
     */
    now(): Date;
}
