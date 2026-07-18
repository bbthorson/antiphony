/**
 * One-shot migration: `processing.denoisedBlobCid` → `processing.processedBlobCid`.
 *
 * Needed only by deployments that ran audio processing BEFORE the state-model
 * widening (contract 0.3.1 / `@antiphony/shared` 0.5.0), which generalized the
 * denoise-specific field into one variant CID for all byte-mutating stages.
 *
 * ## Why this is not optional for an affected deployment
 *
 * `AudioPostRecordSchema` no longer declares `denoisedBlobCid`, and Zod strips
 * unknown keys **silently**. So on an affected deployment the upgrade does not
 * error — every already-denoised post just quietly reverts to serving its
 * ORIGINAL noisy audio, and the cleaned blob is orphaned in storage. There is
 * no log line and no failed stage. That silence is the reason this script
 * exists rather than a note in the changelog.
 *
 * ## Is this deployment affected?
 *
 * Run it. It reports and writes nothing unless `--apply` is passed. A
 * deployment that never ran processing — which includes any that never wired a
 * provider — has nothing to migrate and the script says so.
 *
 * ## Usage
 *
 *   # report what would change (default; writes nothing)
 *   tsx scripts/migrate-processed-blob-cid.ts
 *
 *   # perform the migration
 *   tsx scripts/migrate-processed-blob-cid.ts --apply
 *
 * Requires the same credentials as the server (GOOGLE_APPLICATION_CREDENTIALS
 * or an authenticated gcloud ADC session) and `FIREBASE_STORAGE_BUCKET` /
 * project config as usual.
 *
 * Idempotent: re-running after a successful pass finds nothing. Safe to run
 * before the deploy as well as after — it only moves a field, and the new code
 * reads `processedBlobCid` while the old code reads `denoisedBlobCid`, so
 * there IS a window where one of them is serving the original audio. Prefer
 * running it immediately after the deploy to keep that window short.
 *
 * Idempotence is also what makes a partial run recoverable: a batch that fails
 * mid-pass (a post deleted underneath us fails its whole batch, since
 * `update()` requires the document to exist) leaves earlier batches committed
 * and is resolved by simply running the script again.
 *
 * The per-document decision lives in `src/lib/processed-blob-cid-migration.ts`
 * so it can be unit-tested; this file is the Firestore I/O around it.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../src/lib/firebase-admin.js';
import { planMigration } from '../src/lib/processed-blob-cid-migration.js';
import { COLLECTIONS, NSID } from 'shared/nsid';

const KNOWN_FLAGS = new Set(['--apply']);
const flags = process.argv.slice(2);
const unknown = flags.filter((arg) => !KNOWN_FLAGS.has(arg));
if (unknown.length > 0) {
    // A mistyped `--apply` would otherwise degrade to a dry run, and on a
    // deployment with nothing to migrate both print the same thing — so the
    // typo would read as a completed migration.
    console.error(`Unrecognized argument(s): ${unknown.join(', ')}`);
    console.error('Usage: migrate-processed-blob-cid [--apply]');
    process.exit(2);
}

const APPLY = flags.includes('--apply');
const LEGACY = 'processing.denoisedBlobCid';
const CURRENT = 'processing.processedBlobCid';
/** Firestore caps a batched write at 500 operations. */
const BATCH_LIMIT = 400;

async function main(): Promise<void> {
    const db = getAdminDb();
    const posts = db.collection(COLLECTIONS[NSID.AudioPost]);

    // `!= null` matches documents where the field EXISTS and is non-null;
    // documents without it are not returned at all, which is what we want.
    // `.select()` keeps the payload to the one map we read — audio post docs
    // carry a full record, and this fetches every match at once.
    const snapshot = await posts.where(LEGACY, '!=', null).select('processing').get();

    if (snapshot.empty) {
        console.log('Nothing to migrate: no post carries processing.denoisedBlobCid.');
        return;
    }

    console.log(`${snapshot.size} post(s) carry the legacy field.\n`);

    let migrated = 0;
    let conflicted = 0;
    let skipped = 0;
    let batch = db.batch();
    let pending = 0;

    for (const doc of snapshot.docs) {
        const action = planMigration(doc.get(LEGACY), doc.get(CURRENT));

        if (action.kind === 'skip') {
            console.log(`  ${doc.id}: SKIPPED — ${action.reason}`);
            skipped++;
            continue;
        }

        if (action.kind === 'drop-legacy') {
            console.log(`  ${doc.id}: keeping ${action.kept}, dropping ${action.dropped}`);
            conflicted++;
            if (APPLY) batch.update(doc.ref, { [LEGACY]: FieldValue.delete() });
        } else {
            console.log(`  ${doc.id}: ${action.cid}`);
            migrated++;
            if (APPLY) {
                batch.update(doc.ref, {
                    [CURRENT]: action.cid,
                    [LEGACY]: FieldValue.delete(),
                });
            }
        }

        if (APPLY && ++pending >= BATCH_LIMIT) {
            await batch.commit();
            batch = db.batch();
            pending = 0;
        }
    }

    if (APPLY && pending > 0) await batch.commit();

    console.log('');
    if (conflicted > 0) {
        console.log(`${conflicted} post(s) already had processedBlobCid set to a different value;`);
        console.log('the newer value was kept and the legacy field dropped.');
    }
    if (skipped > 0) {
        console.log(`${skipped} post(s) were skipped and STILL CARRY the legacy field —`);
        console.log('their denoisedBlobCid held no usable CID. Listed above; needs a look.');
    }
    console.log(
        APPLY
            ? `Migrated ${migrated} post(s).`
            : `Dry run: ${migrated} post(s) would be migrated. Re-run with --apply.`,
    );

    if (!APPLY) {
        console.log('\nNo writes were performed.');
    }
}

main()
    .catch((err) => {
        console.error('Migration failed:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        // Releases the Firestore gRPC channel so the process can exit on its
        // own. Preferred over `process.exit()`, which would set the exit code
        // correctly but can truncate buffered stdout — and this script's
        // output IS its result when run as a dry run.
        //
        // Swallowed deliberately: a teardown failure after the writes have
        // committed must not turn a successful migration into a crash, and an
        // unhandled rejection here would replace the message above with a
        // stack trace.
        try {
            await getAdminDb().terminate();
        } catch (err) {
            console.warn('Warning: failed to close the Firestore connection:', err);
        }
    });
