import type { AudioPostDependencies } from '@antiphony/core/ports/audio-posts-dependencies';
import type {
    BlobDrainResult,
    DeletedPostRecord,
    PostDeletionDependencies,
} from '@antiphony/core/ports/post-deletion-dependencies';
import type { StorageService } from '@antiphony/core/services/storage';
import { blobObjectPath } from '../../../lib/blob-path.js';
import { RENDITION_FORMAT_NAMES, renditionObjectPath } from '../../../lib/rendition-path.js';
import type { SqlClient } from '../../../ports/sql-client.js';
import { hydrateRows, type PostRow } from './record-mapping.js';

/**
 * Postgres + R2 `PostDeletionDependencies` (specs/deletion.md), over the tables
 * in `migrations/0003_deletion.sql`.
 *
 * ## The delete is one statement
 *
 * `SqlClient` runs one statement at a time and cannot hold a transaction open
 * (ports/sql-client.ts), so `deletePosts` is a single statement whose
 * data-modifying CTEs remove the rows and transcripts, write the ledger and
 * queue the blobs together. Postgres runs a statement atomically, so either all
 * of that happened or none of it did.
 *
 * ## The bytes go after, through a queue
 *
 * R2 is not in that statement, so the blob CIDs go into `blob_deletions` and
 * `drainBlobDeletions` removes the objects afterwards. A crash between the two
 * leaves the queue saying what is still to do, and the hourly cron finishes it.
 */

/** `record, processing, lease_until`: what `hydrateRows` reads. */
const SELECT_COLS = 'record, processing, lease_until';

interface LedgerRow {
    post_id: string;
    uri: string;
    kind: 'prompt' | 'reply';
    deleted_at: string | Date;
}

interface QueuedRow {
    origin_app_id: string;
    cid: string;
    /** Text, not a Date: a `Date` drops the microseconds the delete compares on. */
    enqueued_at: string;
    referenced: boolean;
}

export function postgresPostDeletionDependencies(
    sql: SqlClient,
    posts: Pick<AudioPostDependencies, 'getAppDid' | 'getPostById' | 'queryByAuthor'>,
    storage: Pick<StorageService, 'deleteObjects'>,
): PostDeletionDependencies {
    return {
        getAppDid: (originAppId) => posts.getAppDid(originAppId),
        getPostById: (originAppId, id) => posts.getPostById(originAppId, id),
        queryByAuthor: (originAppId, authorId, options) => posts.queryByAuthor(originAppId, authorId, options),

        async getDeletedPost(originAppId, postId): Promise<DeletedPostRecord | null> {
            const [row] = await sql.query<LedgerRow>(
                `select post_id, uri, kind, deleted_at from deleted_posts where origin_app_id = $1 and post_id = $2`,
                [originAppId, postId],
            );
            return row
                ? { postId: row.post_id, uri: row.uri, kind: row.kind, deletedAt: new Date(row.deleted_at) }
                : null;
        },

        async listThreadReplies(originAppId, rootUri) {
            // `kind = 'reply'` matches the partial index `posts_reply_root_idx`.
            const rows = await sql.query<PostRow>(
                `select ${SELECT_COLS} from posts
                  where origin_app_id = $1 and reply_root_uri = $2 and kind = 'reply'`,
                [originAppId, rootUri],
            );
            return hydrateRows(rows);
        },

        async deletePosts(originAppId, toDelete) {
            if (toDelete.length === 0) return [];
            // One statement, so it is atomic (see the header). Each CTE reads
            // `removed`, the rows this statement actually deleted, so a post a
            // concurrent call already removed writes no second ledger row and
            // queues nothing twice.
            //
            // The queue upsert moves `enqueued_at` on a CID already queued. A
            // drain that read the older row removes it only if the timestamp is
            // unchanged (below), so a CID re-queued mid-drain survives that drain.
            const rows = await sql.query<{ id: string }>(
                `
                with input as (
                    select * from unnest($2::text[], $3::text[]) as i(id, uri)
                ), removed as (
                    delete from posts p
                     using input i
                     where p.origin_app_id = $1 and p.id = i.id
                    returning p.id, p.kind, p.record, p.processing, i.uri
                ), ledger as (
                    insert into deleted_posts (origin_app_id, post_id, uri, kind)
                    select $1, id, uri, kind from removed
                    on conflict (origin_app_id, post_id) do nothing
                ), transcripts as (
                    delete from audio_transcripts t
                     using removed r
                     where t.subject_uri = r.uri
                ), queued as (
                    insert into blob_deletions (origin_app_id, cid)
                    select distinct $1::text, c.cid
                      from removed r
                     cross join lateral (
                         select r.record -> 'embed' -> 'audio' -> 'ref' ->> '$link' as cid
                         union all
                         select r.processing ->> 'processedBlobCid'
                         union all
                         select jsonb_array_elements_text(coalesce(r.processing -> 'derivedBlobCids', '[]'::jsonb))
                     ) c
                     where c.cid is not null
                    on conflict (origin_app_id, cid) do update set enqueued_at = now()
                )
                select id from removed
                `,
                [originAppId, toDelete.map((p) => p.id), toDelete.map((p) => p.uri)],
            );
            return rows.map((r) => r.id);
        },

        async drainBlobDeletions(originAppId, limit): Promise<BlobDrainResult> {
            // The reference check runs NOW, not when the CID was queued, so a
            // post created in between keeps its audio. A blob is referenced as a
            // post's original audio, its processed variant, or any variant
            // processing wrote for it; each is indexed (0003).
            const queued = await sql.query<QueuedRow>(
                `
                select q.origin_app_id, q.cid, q.enqueued_at::text as enqueued_at,
                       exists (
                           select 1 from posts p
                            where p.origin_app_id = q.origin_app_id
                              and (p.audio_cid = q.cid
                                   or p.processed_blob_cid = q.cid
                                   or (p.processing -> 'derivedBlobCids') ? q.cid)
                       ) as referenced
                  from blob_deletions q
                 where ($1::text is null or q.origin_app_id = $1)
                 order by q.enqueued_at
                 limit $2
                `,
                [originAppId, limit],
            );
            if (queued.length === 0) return { deleted: 0, retained: 0 };

            const unreferenced = queued.filter((q) => !q.referenced);
            const paths = unreferenced.flatMap((q) => objectPathsFor(q.origin_app_id, q.cid));
            // Throws on failure, before the queue rows go, so a failed R2 call
            // leaves them queued for the next drain.
            if (paths.length > 0) await storage.deleteObjects(paths);

            // Only rows whose `enqueued_at` is still the one read above: a CID
            // re-queued since (its referencing post just deleted) stays queued.
            await sql.query(
                `
                delete from blob_deletions q
                 using unnest($1::text[], $2::text[], $3::text[]) as d(origin_app_id, cid, enqueued_at)
                 where q.origin_app_id = d.origin_app_id and q.cid = d.cid and q.enqueued_at = d.enqueued_at::timestamptz
                `,
                [
                    queued.map((q) => q.origin_app_id),
                    queued.map((q) => q.cid),
                    queued.map((q) => q.enqueued_at),
                ],
            );

            return { deleted: unreferenced.length, retained: queued.length - unreferenced.length };
        },
    };
}

/**
 * Every object a blob CID can have: the blob itself and a rendition per
 * format. Renditions are derived from their source CID (lib/rendition-path.ts)
 * and referenced by nothing else, so they go with it. An unsafe segment yields
 * no path and the queue row is simply dropped: no object can live there.
 */
function objectPathsFor(originAppId: string, cid: string): string[] {
    const blob = blobObjectPath(originAppId, cid);
    if (!blob) return [];
    const renditions = RENDITION_FORMAT_NAMES.map((format) => renditionObjectPath(originAppId, cid, format));
    return [blob, ...renditions.filter((p): p is string => p !== null)];
}
