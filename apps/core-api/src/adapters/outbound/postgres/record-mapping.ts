import {
    AudioPostRecordSchema,
    type AudioPostRecord,
} from 'shared/types/audio';
import { logger } from '../../../lib/logger.js';

/**
 * The `AudioPostRecord` ↔ row mapping, shared by the post and processing
 * bindings so the split can only be defined once.
 *
 * ## Why the record is split across three columns
 *
 * `db/schema.sql` stores the canonical record as `jsonb` **minus** its
 * `processing` field, with `processing` in its own column and `lease_until`
 * promoted to a typed one. The reasons are in the schema, but the consequence
 * lives here: every write must take the record apart and every read must put it
 * back together *before* Zod sees it, because `AudioPostRecordSchema.refine`
 * validates the whole shape.
 *
 * Getting this wrong is not a loud failure — a record reassembled without its
 * `processing` key parses perfectly well and simply looks like a post that
 * never requested processing. Hence `splitRecord`/`hydrateRow` as one pair in
 * one file, and a round-trip test over them.
 */

/** A row as the bindings select it. */
export interface PostRow {
    record: unknown;
    processing: unknown;
    lease_until: Date | string | null;
}

export interface SplitRecord {
    /** The record with `processing` removed — the `record` column. */
    record: Record<string, unknown>;
    /** `ProcessingState` minus `leaseUntil`, or null — the `processing` column. */
    processing: Record<string, unknown> | null;
    /** The lease, or null — the `lease_until` column. */
    leaseUntil: Date | null;
    /** Mirror of `record.createdAt` for the typed column + check constraint. */
    createdAt: Date;
}

/**
 * Take a record apart for storage.
 *
 * `leaseUntil` is pulled out of `processing` rather than left in it, so the
 * lease has exactly one home. Leaving a copy in the jsonb would let the two
 * disagree, and the claim statement reads only the column — meaning the stale
 * copy would be the one any human debugging the row saw first.
 */
export function splitRecord(record: AudioPostRecord): SplitRecord {
    const { processing, ...rest } = record;
    if (!processing) {
        return { record: rest, processing: null, leaseUntil: null, createdAt: record.createdAt };
    }
    const { leaseUntil, ...processingRest } = processing;
    return {
        record: rest,
        processing: processingRest,
        leaseUntil: leaseUntil ? new Date(leaseUntil as unknown as string | number | Date) : null,
        createdAt: record.createdAt,
    };
}

/**
 * Put a row back together and validate it.
 *
 * Returns null on a record that fails validation, matching the Firestore
 * binding: a single corrupt row must not fail a whole list query. The caller
 * logs and skips.
 */
export function hydrateRow(row: PostRow): AudioPostRecord | null {
    const base = row.record as Record<string, unknown>;
    const candidate: Record<string, unknown> = { ...base };

    if (row.processing && typeof row.processing === 'object') {
        const processing = { ...(row.processing as Record<string, unknown>) };
        // Only re-attach a lease that is actually stored. Writing
        // `leaseUntil: undefined` would be harmless for Zod but would show up
        // in a JSON diff of the reassembled record, which makes round-trip
        // assertions noisy for no reason.
        if (row.lease_until != null) processing.leaseUntil = row.lease_until;
        candidate.processing = processing;
    }

    const parsed = AudioPostRecordSchema.safeParse(candidate);
    if (!parsed.success) {
        logger.error(
            { postId: base.id, issues: parsed.error.issues },
            '[postgres] AudioPostRecord validation failed; skipping',
        );
        return null;
    }
    return parsed.data;
}

/** Hydrate a list, dropping (and logging) any row that fails validation. */
export function hydrateRows(rows: PostRow[]): AudioPostRecord[] {
    const out: AudioPostRecord[] = [];
    for (const row of rows) {
        const record = hydrateRow(row);
        if (record) out.push(record);
    }
    return out;
}
