import type { AudioPostRecord } from 'shared/types/audio';
import type { ProcessingState } from 'shared/types/processing';
import type { AudioProcessingDependencies } from '@antiphony/core/ports/audio-processing-dependencies';
import type { StorageService } from '@antiphony/core/services/storage';
import type { SqlClient } from '../../../ports/sql-client.js';
import { postgresAudioProcessingDependencies } from './audio-processing-dependencies.js';
import { postgresRemotePostDependencies } from './remote-posts-dependencies.js';

/**
 * `AudioProcessingDependencies` for remote posts (specs/audio-service-mode.md
 * §6): the same processing service, the same stages, lease and blob store,
 * over `remote_posts`, keyed by URI rather than a hosted id.
 *
 * The service works on an `AudioPostRecord`, so `getPostById` presents a remote
 * row in that shape: the record's own fields, its blob ref, the processing
 * state, and the URI as `id`. `subjectOf` hands the URI back unchanged, so the
 * transcript's subject and every webhook name the record by the URI it was
 * registered under, never one built here.
 *
 * Blob reads, derived writes and transcripts are the hosted binding's: blobs
 * live at the same paths, and a transcript is keyed by tenant and subject URI
 * whichever table its post is in (migration 0006).
 */
export function postgresRemoteProcessingDependencies(
    sql: SqlClient,
    storage: StorageService,
): AudioProcessingDependencies {
    const shared = postgresAudioProcessingDependencies(sql, storage);
    const remote = postgresRemotePostDependencies(sql, storage);

    return {
        async getPostById(originAppId, uri): Promise<AudioPostRecord | null> {
            const row = await remote.getRemotePost(originAppId, uri);
            if (!row) return null;
            const { record } = row;
            const kind = record.reply ? 'reply' : 'prompt';
            return {
                id: row.uri,
                cid: row.cid,
                originAppId,
                // A remote post has no tenant-assigned author id; its author is
                // the DID whose repo holds it. Nothing in processing reads these.
                authorId: row.repoDid,
                authorDid: row.repoDid,
                kind,
                ...(kind === 'reply' ? { rootAuthorId: '' } : {}),
                text: record.text,
                ...(record.title !== undefined ? { title: record.title } : {}),
                embed: {
                    $type: 'dev.antiphony.embed.audio',
                    audio: {
                        $type: 'blob',
                        ref: { $link: row.blob.cid },
                        mimeType: row.blob.mimeType,
                        size: row.blob.size,
                    },
                    ...(record.embed.durationMs !== undefined ? { durationMs: record.embed.durationMs } : {}),
                    ...(record.embed.waveform !== undefined ? { waveform: record.embed.waveform } : {}),
                    ...(record.embed.alt !== undefined ? { alt: record.embed.alt } : {}),
                },
                ...(record.reply ? { reply: record.reply } : {}),
                ...(record.langs ? { langs: record.langs } : {}),
                createdAt: row.createdAt,
                ...(row.processing ? { processing: row.processing } : {}),
            };
        },

        subjectOf(post) {
            return { uri: post.id };
        },

        getAppDid(): string {
            // A pass over a remote post never builds a URI: `subjectOf` gives it.
            throw new Error('[remote-processing] a remote post has no app-DID URI');
        },

        readBlobBytes: shared.readBlobBytes,
        writeDerivedBlob: shared.writeDerivedBlob,
        saveTranscript: shared.saveTranscript,
        newTranscriptId: shared.newTranscriptId,
        now: shared.now,

        async patchProcessingState(originAppId, uri, patch: Partial<Omit<ProcessingState, 'updatedAt'>>) {
            // As the hosted binding: a jsonb merge of the patch's own keys, the
            // lease routed to its column, and a variant written for a post
            // removed mid-pass queued for the drain rather than orphaned.
            const { leaseUntil, ...rest } = patch as Record<string, unknown>;
            const merge: Record<string, unknown> = { updatedAt: shared.now() };
            for (const [key, value] of Object.entries(rest)) if (value !== undefined) merge[key] = value;
            const written = [
                ...(typeof rest.processedBlobCid === 'string' ? [rest.processedBlobCid] : []),
                ...(Array.isArray(rest.derivedBlobCids) ? (rest.derivedBlobCids as string[]) : []),
            ];
            const rows = await sql.query<{ uri: string }>(
                `
                with updated as (
                    update remote_posts
                       set processing  = coalesce(processing, '{}'::jsonb) || $3::jsonb,
                           lease_until = coalesce($4, lease_until)
                     where uri = $1 and origin_app_id = $2
                    returning uri
                ), orphaned as (
                    insert into blob_deletions (origin_app_id, cid)
                    select distinct $2::text, c from unnest($5::text[]) as c
                     where not exists (select 1 from updated)
                    on conflict (origin_app_id, cid) do update set enqueued_at = now()
                )
                select uri from updated
                `,
                [uri, originAppId, JSON.stringify(merge), leaseUntil ?? null, written],
            );
            if (rows.length === 0) {
                throw new Error(`[postgres] cannot patch processing state: remote post "${uri}" not found in tenant "${originAppId}"`);
            }
        },

        async claimProcessingLease(originAppId, uri, leaseUntil): Promise<boolean> {
            // One statement, as the hosted binding: see its notes on why
            // `processing is not null` is load-bearing.
            const rows = await sql.query<{ uri: string }>(
                `
                update remote_posts
                   set lease_until = $3
                 where uri = $1
                   and origin_app_id = $2
                   and processing is not null
                   and (lease_until is null or lease_until <= now())
                returning uri
                `,
                [uri, originAppId, leaseUntil],
            );
            return rows.length > 0;
        },

        async releaseProcessingLease(originAppId, uri, leaseUntil): Promise<void> {
            // Compare-and-clear: the claimed lease is the fencing token.
            await sql.query(
                `update remote_posts set lease_until = null
                  where uri = $1 and origin_app_id = $2 and lease_until = $3`,
                [uri, originAppId, leaseUntil],
            );
        },
    };
}
