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
 * Run it. With `--dry-run` (the default) it only reports. A deployment that
 * never ran processing — which includes any that never wired a provider — has
 * nothing to migrate and the script says so.
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
 */
import { getAdminDb } from '../src/lib/firebase-admin.js';
import { COLLECTIONS, NSID } from 'shared/nsid';

const APPLY = process.argv.includes('--apply');
const LEGACY = 'processing.denoisedBlobCid';
const CURRENT = 'processing.processedBlobCid';
/** Firestore caps a batched write at 500 operations. */
const BATCH_LIMIT = 400;

async function main(): Promise<void> {
    const db = getAdminDb();
    const posts = db.collection(COLLECTIONS[NSID.AudioPost]);

    // `!= null` matches documents where the field EXISTS and is non-null;
    // documents without it are not returned at all, which is what we want.
    const snapshot = await posts.where(LEGACY, '!=', null).get();

    if (snapshot.empty) {
        console.log('Nothing to migrate: no post carries processing.denoisedBlobCid.');
        return;
    }

    console.log(`${snapshot.size} post(s) carry the legacy field.\n`);

    const { FieldValue } = (await import('firebase-admin/firestore')) as {
        FieldValue: { delete(): unknown };
    };

    let migrated = 0;
    let conflicted = 0;
    let batch = db.batch();
    let pending = 0;

    for (const doc of snapshot.docs) {
        const processing = doc.get('processing') as Record<string, unknown> | undefined;
        const legacyCid = processing?.denoisedBlobCid as string | undefined;
        const currentCid = processing?.processedBlobCid as string | undefined;

        if (!legacyCid) continue;

        if (currentCid && currentCid !== legacyCid) {
            // Both fields set to DIFFERENT values: the new code has already
            // written a variant for this post. The new one is authoritative
            // (it reflects the current composition of byte-mutating stages),
            // so drop the legacy field rather than overwrite. Reported because
            // it means the deploy ran before the migration and this post was
            // reprocessed in between — worth knowing, not worth failing on.
            conflicted++;
            if (APPLY) batch.update(doc.ref, { [LEGACY]: FieldValue.delete() });
        } else {
            console.log(`  ${doc.id}: ${legacyCid}`);
            migrated++;
            if (APPLY) {
                batch.update(doc.ref, {
                    [CURRENT]: legacyCid,
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
    console.log(
        APPLY
            ? `Migrated ${migrated} post(s).`
            : `Dry run: ${migrated} post(s) would be migrated. Re-run with --apply.`,
    );

    if (!APPLY) {
        console.log('\nNo writes were performed.');
    }
}

main().catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
});
