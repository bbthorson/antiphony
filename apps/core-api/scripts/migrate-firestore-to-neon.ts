/**
 * One-shot migration: Firestore records → Neon.
 *
 *     # Dry run — reads and validates only. Needs NO DATABASE_URL.
 *     # Add --allow-empty if the store is genuinely empty; otherwise reading
 *     # nothing is treated as a probable credential/project mismatch.
 *     GOOGLE_APPLICATION_CREDENTIALS=/path/key.json \
 *     npm run migrate:firestore-to-neon -w @antiphony/core-api -- --dry-run
 *
 *     # For real.
 *     DATABASE_URL=postgres://…  \
 *     GOOGLE_APPLICATION_CREDENTIALS=/path/key.json \
 *     npm run migrate:firestore-to-neon -w @antiphony/core-api
 *
 * ## Scope: records only. Blobs are NOT copied here.
 *
 * The audio bytes move with **Cloudflare Super Slurper** (R2 → Data Migration in
 * the dashboard), which copies GCS → R2 natively given a read-only service
 * account. It handles resumption, parallelism and verification far better than
 * a bespoke loop would, and it needs no R2 credentials on this side — so
 * writing that loop would be strictly worse code doing a strictly worse job.
 *
 * Object paths are unchanged across the copy (`blobs/{originAppId}/{cid}`), so
 * nothing in the records needs rewriting to point at the new bucket. That is a
 * property of content addressing, and it is why these two halves are
 * independent and can run in either order.
 *
 * ## It verifies itself, because the failure mode is silent
 *
 * Every migrated post is read back and its CID recomputed. `jsonb` stores
 * numbers as `numeric`, which is wider than JS — a coercion would change the
 * record and therefore its CID, invalidating every StrongRef pointing at it
 * without erroring anywhere. A post-migration audit would not catch it either,
 * because both sides would agree with themselves.
 *
 * This is covered by unit tests against PGlite, but those use records this
 * repository authored. Real data is the only thing that exercises real data, so
 * the check runs on every row and the script exits non-zero if any row drifts.
 *
 * ## Safe to re-run
 *
 * Every write is an upsert keyed on the record's own id, so a partial run
 * resumes by simply running again. Nothing is deleted from Firestore — cutover
 * is a config change, and rollback is pointing back at the old binding.
 */

import { getAdminDb } from '../src/lib/firebase-admin.js';
import { neonSqlClient, neonConnectionString } from '../src/adapters/outbound/postgres/client.js';
import type { SqlClient } from '../src/ports/sql-client.js';
import { postgresAudioPostDependencies } from '../src/adapters/outbound/postgres/audio-posts-dependencies.js';
import { postgresAudioProcessingDependencies } from '../src/adapters/outbound/postgres/audio-processing-dependencies.js';
import { cidForRecord } from '../src/lib/cid.js';
import {
    AudioPostRecordSchema,
    TranscriptEnrichmentRecordSchema,
} from 'shared/types/audio';
import { COLLECTIONS, NSID } from 'shared/nsid';

const DRY_RUN = process.argv.includes('--dry-run');
/**
 * Acknowledge that reading zero records is expected.
 *
 * Without it, an empty read is treated as a probable misconfiguration rather
 * than a clean result — see the exit check in `main`.
 */
const ALLOW_EMPTY = process.argv.includes('--allow-empty');
/** Firestore page size. Small enough to keep memory flat on a large collection. */
const PAGE = 200;

interface Tally {
    read: number;
    written: number;
    invalid: number;
    cidDrift: number;
}

const posts: Tally = { read: 0, written: 0, invalid: 0, cidDrift: 0 };
const transcripts: Tally = { read: 0, written: 0, invalid: 0, cidDrift: 0 };

function log(...args: unknown[]): void {
    console.log('[migrate]', ...args);
}

/** The project the Admin SDK resolves to — for the summary and the empty-read diagnostic. */
function resolvedProject(): string | undefined {
    return (
        process.env.FIREBASE_PROJECT_ID?.trim() ||
        process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
        process.env.GCLOUD_PROJECT?.trim() ||
        undefined
    );
}

/**
 * Page a Firestore collection by document id.
 *
 * Ordered by `__name__` rather than `createdAt` because this must visit every
 * document exactly once: a createdAt-ordered scan can skip or repeat rows if
 * two documents share a timestamp, and unlike the read path there is no second
 * sort key available on every collection.
 */
async function* pages(collection: string): AsyncGenerator<FirebaseFirestore.QueryDocumentSnapshot[]> {
    const db = getAdminDb();
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
        let q = db.collection(collection).orderBy('__name__').limit(PAGE);
        if (cursor) q = q.startAfter(cursor);
        const snap = await q.get();
        if (snap.empty) return;
        yield snap.docs;
        if (snap.docs.length < PAGE) return;
        cursor = snap.docs[snap.docs.length - 1];
    }
}

async function migratePosts(sql: SqlClient): Promise<void> {
    const deps = postgresAudioPostDependencies(sql);

    for await (const docs of pages(COLLECTIONS[NSID.AudioPost])) {
        for (const doc of docs) {
            posts.read++;
            const parsed = AudioPostRecordSchema.safeParse({ id: doc.id, ...doc.data() });
            if (!parsed.success) {
                // Reported, not fatal: a record that fails validation would
                // already be skipped by the READ path today, so it is not
                // serving traffic and blocking the migration on it helps
                // nobody. It does need a human to look at it.
                posts.invalid++;
                console.error(
                    `[migrate] INVALID post ${doc.id}:`,
                    JSON.stringify(parsed.error.issues),
                );
                continue;
            }
            const record = parsed.data;
            if (DRY_RUN) continue;

            await deps.savePost(record);
            posts.written++;

            // Read back and re-encode. The whole point of doing this inline
            // rather than as a later audit is that a drift found now is one
            // record to investigate; found later it is an unknown subset.
            const readBack = await deps.getPostById(record.originAppId, record.id);
            if (!readBack) {
                posts.cidDrift++;
                console.error(`[migrate] post ${record.id} did not read back after write`);
                continue;
            }
            const before = await cidForRecord(
                JSON.parse(JSON.stringify(record)) as Record<string, unknown>,
            );
            const after = await cidForRecord(
                JSON.parse(JSON.stringify(readBack)) as Record<string, unknown>,
            );
            if (before !== after) {
                posts.cidDrift++;
                console.error(
                    `[migrate] CID DRIFT on post ${record.id}: ${before} -> ${after}`,
                );
            }
        }
        log(`posts: ${posts.read} read, ${posts.written} written`);
    }
}

async function migrateTranscripts(sql: SqlClient): Promise<void> {
    const deps = postgresAudioProcessingDependencies(sql);

    for await (const docs of pages(COLLECTIONS[NSID.AudioTranscript])) {
        for (const doc of docs) {
            transcripts.read++;
            const parsed = TranscriptEnrichmentRecordSchema.safeParse({
                id: doc.id,
                ...doc.data(),
            });
            if (!parsed.success) {
                transcripts.invalid++;
                console.error(
                    `[migrate] INVALID transcript ${doc.id}:`,
                    JSON.stringify(parsed.error.issues),
                );
                continue;
            }
            if (DRY_RUN) continue;
            // Upsert is keyed on subject_uri, so two Firestore transcripts for
            // one post collapse to the last one written — which is the
            // documented contract the old store could not enforce. Worth
            // knowing if the counts come out lower than the read count.
            await deps.saveTranscript(parsed.data);
            transcripts.written++;
        }
        log(`transcripts: ${transcripts.read} read, ${transcripts.written} written`);
    }
}

/**
 * A client that refuses every query, used for `--dry-run` without a database.
 *
 * NOT a no-op stub. A dry run must never write, so if one somehow reaches the
 * database that is a defect in this script — and a stub quietly returning `[]`
 * would hide it, leaving a "dry" run that had silently written. Throwing makes
 * the bug loud at the moment it happens.
 */
function refusingClient(): SqlClient {
    return {
        async query(text: string): Promise<never> {
            throw new Error(
                '[migrate] BUG: --dry-run attempted a database query. ' +
                    `Nothing should reach the store in a dry run. Statement: ${text.trim().slice(0, 120)}`,
            );
        },
    };
}

async function main(): Promise<void> {
    if (DRY_RUN) log('DRY RUN — reading and validating, writing nothing');

    // A dry run reads Firestore and validates; it never writes. Requiring a
    // connection string for it would gate the one command whose entire purpose
    // is to be runnable BEFORE any of the Neon setup exists.
    const conn = neonConnectionString();
    if ('missing' in conn && !DRY_RUN) {
        console.error(
            `[migrate] ${conn.missing} is not set. ` +
                '(Not needed for --dry-run, which writes nothing.)',
        );
        process.exit(1);
    }

    const sql: SqlClient = 'missing' in conn ? refusingClient() : neonSqlClient(conn.url);
    if ('missing' in conn) log('no DATABASE_URL — validating against Firestore only');

    await migratePosts(sql);
    await migrateTranscripts(sql);

    log('---');
    log('project    ', resolvedProject() ?? '(unset — application default credentials)');
    log('posts      ', JSON.stringify(posts));
    log('transcripts', JSON.stringify(transcripts));
    log('---');
    log('Blobs are NOT migrated by this script — use Super Slurper (R2 > Data');
    log('Migration in the dashboard). Object paths are unchanged, so records');
    log('need no rewriting and the two halves can run in either order.');

    // Reading NOTHING from both collections is far more often a credential or
    // project mismatch than a genuinely empty store — and it is the one outcome
    // that looks identical to success. A green dry run over zero records is
    // exactly the report that would convince an operator the migration is safe.
    if (posts.read === 0 && transcripts.read === 0 && !ALLOW_EMPTY) {
        console.error(
            '[migrate] REFUSING to report success: read 0 posts and 0 transcripts.\n' +
                `[migrate]   project: ${resolvedProject() ?? '(unset — application default credentials)'}\n` +
                '[migrate] Check GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_PROJECT_ID point at the\n' +
                '[migrate] project holding the data. If the store really is empty, re-run with\n' +
                '[migrate] --allow-empty to acknowledge it.',
        );
        process.exit(1);
    }

    const drift = posts.cidDrift + transcripts.cidDrift;
    if (drift > 0) {
        console.error(
            `[migrate] FAILED: ${drift} record(s) changed CID through the round trip. ` +
                'Do NOT cut over — every StrongRef pointing at those records would be wrong.',
        );
        process.exit(1);
    }
    const invalid = posts.invalid + transcripts.invalid;
    if (invalid > 0) {
        // Exit 0: these are pre-existing bad rows the read path already skips,
        // so they are not a migration failure. Loud enough not to be missed.
        log(`NOTE: ${invalid} record(s) failed validation and were skipped (see above).`);
    }
}

main().catch((err) => {
    console.error('[migrate] fatal', err);
    process.exit(1);
});
