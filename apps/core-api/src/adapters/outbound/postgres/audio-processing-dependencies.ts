import type { TranscriptEnrichmentRecord } from 'shared/types/audio';
import type { ProcessingState } from 'shared/types/processing';
import { cidForBytes } from '../../../lib/cid.js';
import { blobObjectPath } from '../../../lib/blob-path.js';
import { getAppDid as resolveAppDid } from '../../../lib/app-did.js';
import { newTid } from '../../../lib/tid.js';
import type { SqlClient } from '../../../ports/sql-client.js';
import { postgresAudioPostDependencies } from './audio-posts-dependencies.js';
import type { AudioProcessingDependencies } from '@antiphony/core/ports/audio-processing-dependencies';
import type { StorageService } from '@antiphony/core/services/storage';

/**
 * Postgres-backed `AudioProcessingDependencies`.
 *
 * The lease is the whole story here. The Firestore binding needs a transaction
 * for both claim and release, because each is a read of the current lease
 * followed by a conditional write, and the port's own doc explains at length
 * why a non-atomic version reintroduces the race it exists to close.
 *
 * Both become single statements — the condition moves into the `WHERE` clause
 * and `RETURNING` reports whether it matched. There is no window to interleave
 * in, so there is nothing to serialise.
 *
 * ## Tenancy: a contract the Firestore binding did not keep
 *
 * `claimProcessingLease`'s port doc says it returns false when "the post is
 * gone **or belongs to another tenant**". The Firestore binding takes
 * `_originAppId` and ignores it — every lease operation there is cross-tenant.
 * It has never mattered (the only caller threads the job's own tenant through),
 * but the contract says otherwise and a store that enforces it is strictly
 * safer. These bindings scope every statement by `origin_app_id`, which can
 * only reject a call that was already wrong.
 */

export function postgresAudioProcessingDependencies(
    sql: SqlClient,
    StorageService: StorageService,
): AudioProcessingDependencies {
    const posts = postgresAudioPostDependencies(sql);
    const now = (): Date => new Date();

    return {
        getPostById: (originAppId, postId) => posts.getPostById(originAppId, postId),

        getAppDid(originAppId: string): string {
            return resolveAppDid(originAppId);
        },

        async readBlobBytes(originAppId, blobCid) {
            const path = blobObjectPath(originAppId, blobCid);
            if (!path) return null;
            return StorageService.download(path);
        },

        async writeDerivedBlob(originAppId, bytes, mimeType) {
            const buf = Buffer.from(bytes);
            const cid = await cidForBytes(buf);
            const path = blobObjectPath(originAppId, cid);
            if (!path) throw new Error('derived blob path could not be derived');
            await StorageService.uploadFile(buf, path, mimeType);
            return cid;
        },

        async saveTranscript(record: TranscriptEnrichmentRecord): Promise<void> {
            // Last-write-wins by subject uri — which the port documents and
            // Firestore could only hope for. `subject_uri` is a generated
            // column with a UNIQUE index (db/schema.sql), so the contract is
            // now enforced by the store: a second transcript for a post
            // REPLACES the first instead of quietly coexisting with it.
            await sql.query(
                `
                insert into audio_transcripts (id, record, created_at)
                values ($1, $2::jsonb, $3)
                on conflict (subject_uri) do update
                    set id         = excluded.id,
                        record     = excluded.record,
                        created_at = excluded.created_at
                `,
                [record.id, JSON.stringify(record), record.createdAt],
            );
        },

        async patchProcessingState(
            originAppId: string,
            postId: string,
            patch: Partial<Omit<ProcessingState, 'updatedAt'>>,
        ): Promise<void> {
            // A jsonb merge (`||`) touches only the keys in the patch, leaving
            // sibling stages alone — the same effect as Firestore's dotted
            // field paths, and driven off the patch's own keys for the same
            // reason: an allowlist that falls behind the schema drops writes
            // SILENTLY, which for a stage's output means the state reads
            // `ready` while the artifact went nowhere.
            const { leaseUntil, ...rest } = patch as Record<string, unknown>;
            const merge: Record<string, unknown> = { updatedAt: now() };
            for (const [key, value] of Object.entries(rest)) {
                if (value !== undefined) merge[key] = value;
            }

            // `leaseUntil` has its own column, so a patch carrying one is
            // routed there rather than into the jsonb. Nothing does this today
            // — the lease moves through claim/release — but the patch type
            // permits it, and silently dropping it would be the worse failure.
            const rows = await sql.query<{ id: string }>(
                `
                update posts
                   set processing  = coalesce(processing, '{}'::jsonb) || $3::jsonb,
                       lease_until = coalesce($4, lease_until)
                 where id = $1 and origin_app_id = $2
                returning id
                `,
                [postId, originAppId, JSON.stringify(merge), leaseUntil ?? null],
            );

            // Firestore's `update()` rejects on a missing document. Preserved:
            // a patch aimed at a post that is gone means the caller's view of
            // the world is wrong, and a silent no-op would settle a stage in
            // memory while nothing was written.
            if (rows.length === 0) {
                throw new Error(
                    `[postgres] cannot patch processing state: post "${postId}" not found in tenant "${originAppId}"`,
                );
            }
        },

        async claimProcessingLease(originAppId, postId, leaseUntil): Promise<boolean> {
            // One statement, so there is no read-then-write window for a second
            // runner to slip into.
            //
            // `processing is not null` is load-bearing and not an optimisation:
            // claiming a post that never requested processing would CREATE the
            // processing object, and the service reads a present object as
            // "processing was requested" — so a no-op job would permanently
            // change how that post renders.
            //
            // `lease_until <= now()` is strictly-expired, matching the
            // Firestore binding's strictly-greater held check: a lease expiring
            // exactly now is expired and claimable.
            const rows = await sql.query<{ id: string }>(
                `
                update posts
                   set lease_until = $3
                 where id = $1
                   and origin_app_id = $2
                   and processing is not null
                   and (lease_until is null or lease_until <= now())
                returning id
                `,
                [postId, originAppId, leaseUntil],
            );
            return rows.length > 0;
        },

        async releaseProcessingLease(originAppId, postId, leaseUntil): Promise<void> {
            // Compare-and-clear. The `lease_until = $3` predicate IS the
            // fencing token: a runner whose lease lapsed mid-pass has already
            // been superseded, and clearing unconditionally there would hand a
            // third runner the post while the second is still working —
            // restoring the exact hazard the lease closes, at the moment the
            // system is already slow enough to have caused it.
            //
            // Set to NULL rather than a past timestamp so "never leased" and
            // "released" are one state, not two that read differently.
            await sql.query(
                `
                update posts
                   set lease_until = null
                 where id = $1 and origin_app_id = $2 and lease_until = $3
                `,
                [postId, originAppId, leaseUntil],
            );
        },

        // Firestore minted these from `collection().doc().id`. A TID is the
        // better fit now that the store has no opinion: time-sortable, and the
        // same key format every other record here uses.
        newTranscriptId(): string {
            return newTid();
        },

        now,
    };
}
