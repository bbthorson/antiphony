/**
 * Decision logic for the `denoisedBlobCid` → `processedBlobCid` migration
 * (`scripts/migrate-processed-blob-cid.ts`).
 *
 * Split out from the script so it is testable: the script's Firestore I/O
 * cannot run locally without an emulator, and the deployment that motivated
 * the migration has zero affected records — so without this seam every branch
 * below would first execute against a self-hoster's live data.
 */

/** What to do with one document carrying the legacy field. */
export type MigrationAction =
    /** Move the legacy value to `processedBlobCid` and delete the old key. */
    | { kind: 'migrate'; cid: string }
    /** A newer `processedBlobCid` already exists; drop the legacy key only. */
    | { kind: 'drop-legacy'; kept: string; dropped: string }
    /** Nothing actionable. `reason` is surfaced to the operator. */
    | { kind: 'skip'; reason: string };

/** A CID we are willing to write. Guards against `''` and non-string junk. */
function usableCid(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Decide what a single document needs, given both field values.
 *
 * Total over every input including junk: the query selects documents by field
 * presence, not by type, so a partial write can surface `''`, a number, or a
 * nested map here.
 */
export function planMigration(legacyValue: unknown, currentValue: unknown): MigrationAction {
    const legacy = usableCid(legacyValue);
    const current = usableCid(currentValue);

    if (!legacy) {
        // Matched the query (the key exists and is non-null) but holds nothing
        // we can move. Reported rather than passed over in silence: leaving the
        // key in place is a state the operator should see.
        return {
            kind: 'skip',
            reason: `unusable denoisedBlobCid (${JSON.stringify(legacyValue)})`,
        };
    }

    if (current && current !== legacy) {
        // Both set to DIFFERENT values: the new code already wrote a variant
        // for this post, which reflects the current composition of
        // byte-mutating stages and therefore wins. Means the deploy ran before
        // the migration and this post was reprocessed in between — worth
        // reporting, not worth failing on.
        return { kind: 'drop-legacy', kept: current, dropped: legacy };
    }

    // Either no current value, or it already equals the legacy one (a re-run
    // after a partial pass). Both converge on the same write, which is what
    // makes the migration idempotent.
    return { kind: 'migrate', cid: legacy };
}
