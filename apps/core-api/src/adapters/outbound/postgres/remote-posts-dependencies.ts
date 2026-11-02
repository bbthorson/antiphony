import { TranscriptEnrichmentRecordSchema, type TranscriptEnrichmentRecord } from 'shared/types/audio';
import { ProcessingStateSchema, type ProcessingState } from 'shared/types/processing';
import { RemoteAudioPostRecordSchema, RemoteSpaceSchema, type RemoteSpace } from 'shared/types/remote-posts';
import type {
    RemotePostDependencies,
    RemotePostRow,
    RemoteSweepRow,
} from '@antiphony/core/ports/remote-posts-dependencies';
import type { StorageService } from '@antiphony/core/services/storage';
import { audioPlaybackUrl, signedAudioPlaybackUrl } from '../../../lib/audio-url.js';
import { blobObjectPath } from '../../../lib/blob-path.js';
import { BLOB_SPACE_AUTHORITY_METADATA_KEY, BLOB_SPACE_METADATA_KEY, blobSpaceOf } from '../../../lib/blob-space.js';
import { cidForBytes, cidForRepoRecord } from '../../../lib/cid.js';
import { logger } from '../../../lib/logger.js';
import type { SqlClient } from '../../../ports/sql-client.js';

/**
 * Postgres `RemotePostDependencies` over `remote_posts` (migrations 0006, 0008), with
 * blobs in the same store and at the same paths as uploads, so playback,
 * renditions and the processing pipeline read a remote post's audio exactly
 * as they read a hosted post's.
 *
 * Removal is one statement, like deleting a hosted post (specs/deletion.md
 * § 6.1): the row, its transcript and a ledger entry go together, and the
 * blob and its variants are queued for the drain, which keeps any object
 * another post still references.
 *
 * Turning a blob public (§7) rewrites R2 metadata, which can't be edited in
 * place: each object is read and written back to the same path, without the
 * space marking. The bytes, path and CID are the same.
 */

interface RemoteRow {
    origin_app_id: string;
    uri: string;
    cid: string;
    repo_did: string;
    collection: string;
    rkey: string;
    space: unknown;
    verified: 'fetched' | 'pushed';
    record: unknown;
    blob_cid: string;
    mime_type: string;
    size: string | number;
    blob_private: boolean;
    processing: unknown;
    lease_until: Date | string | null;
    created_at: Date | string;
    registered_at: Date | string;
    checked_at: Date | string;
    gone_at: Date | string | null;
    unreachable_since: Date | string | null;
}

const COLS = `origin_app_id, uri, cid, repo_did, collection, rkey, space, verified, record, blob_cid, mime_type, size, blob_private,
              processing, lease_until, created_at, registered_at, checked_at, gone_at, unreachable_since`;

const date = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const maybeDate = (v: Date | string | null): Date | null => (v === null ? null : date(v));

function toRow(r: RemoteRow): RemotePostRow | null {
    const record = RemoteAudioPostRecordSchema.safeParse(r.record);
    if (!record.success) {
        logger.error({ uri: r.uri, issues: record.error.issues }, '[postgres] stored remote record failed validation; skipping');
        return null;
    }
    let space: RemoteSpace | null = null;
    if (r.space !== null) {
        const parsed = RemoteSpaceSchema.safeParse(r.space);
        if (!parsed.success) {
            // A space row read as a plain one would play unsigned. Skip it.
            logger.error({ uri: r.uri, issues: parsed.error.issues }, '[postgres] stored remote space failed validation; skipping');
            return null;
        }
        space = parsed.data;
    }
    let processing: ProcessingState | undefined;
    if (r.processing && typeof r.processing === 'object') {
        const parsed = ProcessingStateSchema.safeParse({
            ...(r.processing as Record<string, unknown>),
            ...(r.lease_until !== null ? { leaseUntil: r.lease_until } : {}),
        });
        if (parsed.success) processing = parsed.data;
        else logger.error({ uri: r.uri, issues: parsed.error.issues }, '[postgres] remote processing state invalid; ignoring');
    }
    return {
        originAppId: r.origin_app_id,
        uri: r.uri,
        cid: r.cid,
        repoDid: r.repo_did,
        collection: r.collection,
        rkey: r.rkey,
        space,
        verified: r.verified,
        record: record.data,
        blob: { cid: r.blob_cid, mimeType: r.mime_type, size: Number(r.size) },
        blobPrivate: r.blob_private,
        processing,
        createdAt: date(r.created_at),
        registeredAt: date(r.registered_at),
        checkedAt: date(r.checked_at),
        goneAt: maybeDate(r.gone_at),
        unreachableSince: maybeDate(r.unreachable_since),
    };
}

/** The processing state as the jsonb column holds it: no lease (its own column). */
function processingJson(state: ProcessingState | undefined): string | null {
    if (!state) return null;
    const { leaseUntil: _lease, ...rest } = state;
    return JSON.stringify(rest);
}

export function postgresRemotePostDependencies(
    sql: SqlClient,
    storage: StorageService,
    now: () => Date = () => new Date(),
): RemotePostDependencies {
    return {
        async getRemotePost(originAppId, uri) {
            const [row] = await sql.query<RemoteRow>(
                `select ${COLS} from remote_posts where origin_app_id = $1 and uri = $2`,
                [originAppId, uri],
            );
            return row ? toRow(row) : null;
        },

        async saveRemotePost(w) {
            // When the blob changed, the old blob and every variant made from it
            // go to the drain, which keeps any another post still references.
            await sql.query(
                `
                with prev as (
                    select blob_cid, processing from remote_posts where origin_app_id = $1 and uri = $2
                ), saved as (
                    insert into remote_posts (origin_app_id, uri, cid, repo_did, collection, rkey, record,
                                              blob_cid, mime_type, size, blob_private, processing, created_at,
                                              space, verified)
                    values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb, $15)
                    on conflict (origin_app_id, uri) do update
                        set cid = excluded.cid, repo_did = excluded.repo_did, collection = excluded.collection,
                            rkey = excluded.rkey, space = excluded.space, verified = excluded.verified,
                            record = excluded.record, blob_cid = excluded.blob_cid,
                            mime_type = excluded.mime_type, size = excluded.size,
                            blob_private = excluded.blob_private, processing = excluded.processing,
                            created_at = excluded.created_at,
                            checked_at = now(), gone_at = null, unreachable_since = null
                    returning 1
                ), cleared as (
                    delete from deleted_remote_posts where origin_app_id = $1 and uri = $2
                ), queued as (
                    insert into blob_deletions (origin_app_id, cid)
                    select distinct $1::text, c.cid
                      from prev p
                     cross join lateral (
                         select p.blob_cid as cid
                         union all select p.processing ->> 'processedBlobCid'
                         union all select jsonb_array_elements_text(coalesce(p.processing -> 'derivedBlobCids', '[]'::jsonb))
                     ) c
                     where p.blob_cid <> $8 and c.cid is not null
                    on conflict (origin_app_id, cid) do update set enqueued_at = now()
                )
                select 1 from saved
                `,
                [
                    w.originAppId,
                    w.uri,
                    w.cid,
                    w.repoDid,
                    w.collection,
                    w.rkey,
                    JSON.stringify(w.record),
                    w.blob.cid,
                    w.blob.mimeType,
                    w.blob.size,
                    w.blobPrivate,
                    processingJson(w.processing),
                    w.createdAt,
                    w.space ? JSON.stringify(w.space) : null,
                    w.verified,
                ],
            );
        },

        async getDeletedRemotePost(originAppId, uri) {
            const [row] = await sql.query<{ deleted_at: Date | string; reason: 'tenant' | 'gone' }>(
                'select deleted_at, reason from deleted_remote_posts where origin_app_id = $1 and uri = $2',
                [originAppId, uri],
            );
            return row ? { deletedAt: date(row.deleted_at), reason: row.reason } : null;
        },

        async deleteRemotePost(originAppId, uri, reason) {
            const rows = await sql.query<{ uri: string }>(
                `
                with removed as (
                    delete from remote_posts where origin_app_id = $1 and uri = $2
                    returning uri, blob_cid, processing
                ), ledger as (
                    insert into deleted_remote_posts (origin_app_id, uri, reason)
                    select $1, uri, $3 from removed
                    on conflict (origin_app_id, uri) do update set reason = excluded.reason, deleted_at = now()
                ), transcripts as (
                    delete from audio_transcripts t
                     using removed r
                     where t.origin_app_id = $1 and t.subject_uri = r.uri
                ), queued as (
                    insert into blob_deletions (origin_app_id, cid)
                    select distinct $1::text, c.cid
                      from removed r
                     cross join lateral (
                         select r.blob_cid as cid
                         union all select r.processing ->> 'processedBlobCid'
                         union all select jsonb_array_elements_text(coalesce(r.processing -> 'derivedBlobCids', '[]'::jsonb))
                     ) c
                     where c.cid is not null
                    on conflict (origin_app_id, cid) do update set enqueued_at = now()
                )
                select uri from removed
                `,
                [originAppId, uri, reason],
            );
            return rows.length > 0;
        },

        async listThread(originAppId, rootUri, { limit, cursor }) {
            // Oldest first, keyed on (created_at, uri). The cursor is the last
            // URI of the previous page; one that isn't this tenant's starts from
            // the top, as the other listings do.
            const rows = await sql.query<RemoteRow>(
                `
                with cursor as (
                    select created_at, uri from remote_posts where origin_app_id = $1 and uri = $3
                )
                select ${COLS} from remote_posts
                 where origin_app_id = $1 and reply_root_uri = $2
                   and ($3::text is null
                        or not exists (select 1 from cursor)
                        or (created_at, uri) > (select created_at, uri from cursor))
                 order by created_at, uri
                 limit $4
                `,
                [originAppId, rootUri, cursor ?? null, limit + 1],
            );
            const items = rows.slice(0, limit).map(toRow).filter((r): r is RemotePostRow => r !== null);
            return { items, nextCursor: rows.length > limit ? (rows[limit - 1]?.uri ?? null) : null };
        },

        async mergeProcessing(originAppId, uri, resolved) {
            const merge: Record<string, unknown> = { updatedAt: now() };
            for (const [k, v] of Object.entries(resolved)) if (v !== undefined) merge[k] = v;
            await sql.query(
                `update remote_posts set processing = coalesce(processing, '{}'::jsonb) || $3::jsonb
                  where origin_app_id = $1 and uri = $2`,
                [originAppId, uri, JSON.stringify(merge)],
            );
        },

        async listForSweep(limit): Promise<RemoteSweepRow[]> {
            const rows = await sql.query<Pick<RemoteRow, 'origin_app_id' | 'uri' | 'cid' | 'gone_at' | 'unreachable_since'>>(
                // A pushed space record can't be read before Phase C (§8.1).
                `select origin_app_id, uri, cid, gone_at, unreachable_since
                   from remote_posts where verified = 'fetched'
                  order by checked_at, origin_app_id, uri limit $1`,
                [limit],
            );
            return rows.map((r) => ({
                originAppId: r.origin_app_id,
                uri: r.uri,
                cid: r.cid,
                goneAt: maybeDate(r.gone_at),
                unreachableSince: maybeDate(r.unreachable_since),
            }));
        },

        async recordCheck(originAppId, uri, outcome) {
            // The service's clock, not the database's: it compares these
            // timestamps with its own `now()`.
            await sql.query(
                `
                update remote_posts
                   set checked_at = $4,
                       gone_at = case when $3 = 'gone' then coalesce(gone_at, $4) else null end,
                       unreachable_since = case when $3 = 'unreachable' then coalesce(unreachable_since, $4) else null end
                 where origin_app_id = $1 and uri = $2
                `,
                [originAppId, uri, outcome, now()],
            );
        },

        async getTranscripts(originAppId, uris): Promise<Map<string, TranscriptEnrichmentRecord>> {
            const map = new Map<string, TranscriptEnrichmentRecord>();
            if (uris.length === 0) return map;
            const rows = await sql.query<{ record: unknown }>(
                'select record from audio_transcripts where origin_app_id = $1 and subject_uri = any($2)',
                [originAppId, uris],
            );
            for (const row of rows) {
                const parsed = TranscriptEnrichmentRecordSchema.safeParse(row.record);
                if (parsed.success) map.set(parsed.data.subject.uri, parsed.data);
            }
            return map;
        },

        async getStoredBlob(originAppId, cid) {
            const path = blobObjectPath(originAppId, cid);
            if (!path) return null;
            const stat = await storage.stat(path);
            return stat ? { space: blobSpaceOf(stat.metadata) } : null;
        },

        async storeBlob(originAppId, cid, bytes, mimeType) {
            const path = blobObjectPath(originAppId, cid);
            if (!path) throw new Error(`[remote-posts] no storage path for ${cid}`);
            // The first write wins, as for uploads (lib/blob-space.ts): bytes
            // stored meanwhile keep the visibility they have.
            const existing = await storage.stat(path);
            if (existing) return { space: blobSpaceOf(existing.metadata) };
            await storage.uploadFile(bytes, path, mimeType);
            return { space: null };
        },

        async hasVerifiedPublicReference(originAppId, blobCid) {
            // A hosted flat post (no space), or a public remote post Antiphony
            // fetched. Pushed records, and posts in spaces, never count.
            const [row] = await sql.query<{ found: boolean }>(
                `
                select exists (
                    select 1 from posts
                     where origin_app_id = $1 and audio_cid = $2 and space_type is null
                ) or exists (
                    select 1 from remote_posts
                     where origin_app_id = $1 and blob_cid = $2 and space is null and verified = 'fetched'
                ) as found
                `,
                [originAppId, blobCid],
            );
            return row?.found === true;
        },

        async makeBlobPublic(originAppId, blobCid) {
            // The original, and every variant any post of this tenant derived
            // from it, hosted or remote.
            const rows = await sql.query<{ cid: string }>(
                `
                with sources as (
                    select processing from posts where origin_app_id = $1 and audio_cid = $2
                    union all
                    select processing from remote_posts where origin_app_id = $1 and blob_cid = $2
                )
                select distinct c.cid
                  from sources s
                 cross join lateral (
                     select s.processing ->> 'processedBlobCid' as cid
                     union all select jsonb_array_elements_text(coalesce(s.processing -> 'derivedBlobCids', '[]'::jsonb))
                 ) c
                 where c.cid is not null
                `,
                [originAppId, blobCid],
            );
            // Variants first, the original last: a failure part way leaves the
            // original private, so the registration fails and a retry redoes it.
            for (const cid of [...rows.map((r) => r.cid).filter((c) => c !== blobCid), blobCid]) {
                const path = blobObjectPath(originAppId, cid);
                if (!path) continue;
                const stat = await storage.stat(path);
                if (!stat || blobSpaceOf(stat.metadata) === null) continue;
                const bytes = await storage.download(path);
                if (!bytes) continue;
                const { [BLOB_SPACE_METADATA_KEY]: _space, [BLOB_SPACE_AUTHORITY_METADATA_KEY]: _authority, ...rest } =
                    stat.metadata ?? {};
                await storage.uploadFile(
                    bytes,
                    path,
                    stat.mimeType ?? 'application/octet-stream',
                    Object.keys(rest).length > 0 ? { metadata: rest } : undefined,
                );
                logger.info({ originAppId, cid, original: blobCid }, '[remote-posts] blob turned public by a verified public reference');
            }
        },

        cidForBytes,
        cidForRepoRecord,

        resolveAudioUrl(originAppId, blobCid, isPrivate) {
            if (isPrivate) return signedAudioPlaybackUrl(originAppId, blobCid);
            return Promise.resolve(audioPlaybackUrl(originAppId, blobCid));
        },

        now,
    };
}
