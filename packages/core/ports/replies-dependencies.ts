import type { ReplyRecord, ReplyEnrichmentRecord } from 'shared/types/records';

/**
 * Maps a reply's `sentiment` enum value to the lowercase bucket key used in
 * `PromptDocument.sentimentCounts`. Returns null if the input isn't a
 * recognized sentiment string (missing, undefined, or unexpected value).
 *
 * Kept in this file so both Firebase-backed bindings (apps/core-api and
 * apps/web) share the mapping verbatim, and tests can assert it directly.
 */
export function sentimentKey(s: unknown): 'positive' | 'neutral' | 'negative' | null {
    if (s === 'Positive') return 'positive';
    if (s === 'Neutral') return 'neutral';
    if (s === 'Negative') return 'negative';
    return null;
}

export interface AggregateDeltaAccumulator {
    sumDelta: number;
    countDelta: number;
    positive: number;
    neutral: number;
    negative: number;
}

/**
 * Builds the prompt-doc update object for an aggregate delta. Skips
 * sentiment buckets with zero delta so the write stays minimal.
 *
 * Returns a `Record<string, unknown>` because the values are
 * `FieldValue.increment(...)` instances at the Firestore layer; the helper
 * takes a delta-to-increment factory so packages/core stays Firebase-free.
 */
export function promptAggregateUpdate(
    d: AggregateDeltaAccumulator,
    increment: (delta: number) => unknown,
): Record<string, unknown> {
    const update: Record<string, unknown> = {
        engagementScoreSum: increment(d.sumDelta),
        engagementScoreCount: increment(d.countDelta),
    };
    if (d.positive !== 0) update['sentimentCounts.positive'] = increment(d.positive);
    if (d.neutral !== 0) update['sentimentCounts.neutral'] = increment(d.neutral);
    if (d.negative !== 0) update['sentimentCounts.negative'] = increment(d.negative);
    return update;
}

/**
 * Computes the single-reply aggregate-delta update for a status flip.
 * Returns null when the flip doesn't cross the live boundary OR when the
 * reply lacks AI enrichment / sentiment / score.
 *
 * The single-reply path uses this; the bulk path uses
 * `AggregateDeltaAccumulator` + `promptAggregateUpdate` because deltas across
 * many replies share a target prompt.
 */
export function computeAggregateDelta(
    currentStatus: string,
    nextStatus: 'live' | 'archived' | 'deleted',
    aiStatus: unknown,
    sentiment: unknown,
    engagementScore: unknown,
    increment: (delta: number) => unknown,
): Record<string, unknown> | null {
    const wasLive = currentStatus === 'live';
    const isLive = nextStatus === 'live';
    if (wasLive === isLive) return null;
    if (aiStatus !== 'complete') return null;
    if (typeof engagementScore !== 'number') return null;
    const sk = sentimentKey(sentiment);
    if (!sk) return null;
    const sign = isLive ? 1 : -1;
    return {
        engagementScoreSum: increment(sign * engagementScore),
        engagementScoreCount: increment(sign),
        [`sentimentCounts.${sk}`]: increment(sign),
    };
}

/**
 * ReplyDependencies is the portable interface that ReplyService uses to access
 * the underlying data store. Lives in `packages/core/` alongside the class;
 * the Firestore-backed default implementation lives in
 * `apps/core-api/src/adapters/outbound/firebase/replies-dependencies.ts` as
 * the binding. (Pre-Phase-4a there was also an apps/web binding; that's
 * gone — apps/web is a pure HTTP client of core-api now.)
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

    // --- Reply Enrichments (sibling namespace: enrichments/replies/{id}) ---
    //
    // Per-reply CRM data owned by the prompt author. Lives in a separate
    // Firestore collection space from canonical reply records so self-hosters
    // see clean records without phantom CRM fields. See
    // specs/data-separation.md § 3.

    /** Fetch a single reply enrichment record, or null if no enrichment doc exists. */
    getReplyEnrichmentById(replyId: string): Promise<ReplyEnrichmentRecord | null>;

    /**
     * Batch fetch enrichment records. Returns a Map keyed by replyId so the
     * caller can zip with the source replies (some may have no enrichment).
     * Missing replies are simply absent from the Map.
     */
    getReplyEnrichmentsByIds(replyIds: string[]): Promise<Map<string, ReplyEnrichmentRecord>>;

    /**
     * Apply a partial update to a reply's enrichment doc. Creates the doc on
     * first write (set with merge), so callers don't need to check existence.
     */
    updateReplyEnrichment(
        replyId: string,
        updates: Partial<Omit<ReplyEnrichmentRecord, 'id'>>,
    ): Promise<void>;

    // --- Writes ---

    /** Generate a new unique reply ID without creating the document. */
    newReplyId(): string;

    /** Apply a partial update to a single reply. */
    updateReply(replyId: string, updates: Partial<ReplyRecord>): Promise<void>;

    /** Apply the same partial update to many replies atomically where possible. */
    bulkUpdateReplies(replyIds: string[], updates: Partial<ReplyRecord>): Promise<void>;

    /**
     * Atomically: updates a reply's `status` AND, when the reply has completed
     * AI enrichment with both `sentiment` + `engagementScore` set, applies the
     * matching delta to the parent prompt's analytics aggregates
     * (`engagementScoreSum`/`Count` and `sentimentCounts`). Aggregates count
     * `status: 'live'` replies only, so:
     *   `live → archived|deleted`: decrement.
     *   `archived|deleted → live`: increment.
     *   `archived ↔ deleted` or unchanged status: no aggregate write.
     *
     * Single source of truth for status-flip aggregate maintenance — callers
     * should NOT combine `updateReply({status})` with manual aggregate writes.
     */
    updateReplyStatusWithAggregates(
        prevReply: ReplyRecord,
        nextStatus: 'live' | 'archived' | 'deleted',
    ): Promise<void>;

    /**
     * Bulk variant of `updateReplyStatusWithAggregates`. Aggregates the deltas
     * per `promptId` and emits one prompt update per affected prompt, then
     * chunks the combined (reply + prompt) write set to stay under Firestore's
     * 500-op batch limit. Trusts caller-supplied prev state — adequate for the
     * UI-driven bulk archive flow; concurrent flips on the same set are rare.
     */
    bulkUpdateRepliesStatusWithAggregates(
        prevReplies: ReplyRecord[],
        nextStatus: 'live' | 'archived' | 'deleted',
    ): Promise<void>;

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
