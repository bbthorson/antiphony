import type { ReplyRecord } from 'shared/types';

/**
 * ReplyDependencies is the portable interface that ReplyService uses to access
 * the underlying data store. Lives in `packages/core/` alongside the class;
 * the Firestore-backed default implementation lives in
 * `apps/web/src/services/replies-dependencies.ts` as the binding.
 *
 * Transactions: rather than exposing a generic `runTransaction(fn)` that
 * would leak Firestore-specific semantics into the service, the one atomic
 * operation we need is bundled into a single named method
 * (`createReplyWithCounterIncrement`) whose implementation chooses the right
 * primitives for its store.
 */

export interface ReplyQueryOptions {
    /** When true, include replies with `status === 'archived'`. Default: false. */
    includeArchived?: boolean;
    // Deleted replies and legacy records with non-public `visibility` are
    // always excluded at the data layer.
}

/**
 * Activity records are written alongside reply creation. Mirrors
 * `ActivityRecord` in prompts-dependencies; kept inline here so the reply
 * deps don't import from the prompt deps during the migration.
 */
export interface ReplyActivityRecord {
    id: string;
    type: 'Reply';
    actor: string;
    object: unknown;
    createdAt: Date;
}

export interface ReplyDependencies {
    // --- Queries ---

    /** Fetch all replies for a prompt, ordered by createdAt desc. Applies status/legacy filters. */
    queryByPromptId(promptId: string, options?: ReplyQueryOptions): Promise<ReplyRecord[]>;

    /**
     * Fetch replies across many prompts. Implementation handles batching
     * (Firestore `in` queries are capped at 30 values; Postgres has no such
     * cap). Result ordering is not specified — the caller groups and sorts.
     */
    queryByPromptIds(promptIds: string[], options?: ReplyQueryOptions): Promise<ReplyRecord[]>;

    /** Fetch a single reply record by ID, or null if missing. */
    getReplyById(replyId: string): Promise<ReplyRecord | null>;

    /**
     * Batch fetch reply records by ID. Result is positionally aligned with
     * the input — `null` at indices where the reply is missing or fails
     * schema validation. Callers that need only the found subset should
     * filter out nulls.
     */
    getRepliesByIds(replyIds: string[]): Promise<Array<ReplyRecord | null>>;

    // --- Writes ---

    /** Generate a new unique reply ID without creating the document. */
    newReplyId(): string;

    /** Apply a partial update to a single reply. */
    updateReply(replyId: string, updates: Partial<ReplyRecord>): Promise<void>;

    /** Apply the same partial update to many replies atomically where possible. */
    bulkUpdateReplies(replyIds: string[], updates: Partial<ReplyRecord>): Promise<void>;

    /** Add `userId` to the reply's `readBy` set (idempotent). Hides arrayUnion. */
    markReplyRead(replyId: string, userId: string): Promise<void>;

    /** Add `userId` to many replies' `readBy` sets atomically where possible. */
    bulkMarkRepliesRead(replyIds: string[], userId: string): Promise<void>;

    // --- Named transaction ---

    /** Generate a new unique activity ID. */
    newActivityId(): string;

    /**
     * Atomically: verifies the parent prompt exists (throws NotFoundError),
     * writes the reply, increments `prompt.replyCount`, updates
     * `prompt.lastReplyAt`, and — if `activity` is provided — writes the
     * activity record.
     *
     * This is the one operation where atomicity is a correctness requirement:
     * a reply that lands without its counter increment is a silent data bug.
     */
    createReplyWithCounterIncrement(
        reply: ReplyRecord,
        activity: ReplyActivityRecord | null,
    ): Promise<void>;

    /** Current server time as a `Date`. */
    now(): Date;
}
