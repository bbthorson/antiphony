import {
    TranscriptEnrichmentRecordSchema,
    type AudioPostRecord,
    type TranscriptEnrichmentRecord,
} from 'shared/types/audio';
import { logger } from '../../../lib/logger.js';
import { cidForRecord } from '../../../lib/cid.js';
import { getAppDid as resolveAppDid } from '../../../lib/app-did.js';
import { newTid } from '../../../lib/tid.js';
import { audioPlaybackUrl } from '../../../lib/audio-url.js';
import type { SqlClient } from '../../../ports/sql-client.js';
import { hydrateRows, splitRecord, type PostRow } from './record-mapping.js';
import type {
    AudioPostDependencies,
    AudioPostQueryOptions,
    AudioPostThreadOptions,
} from '@antiphony/core/ports/audio-posts-dependencies';

/**
 * Postgres-backed `AudioPostDependencies`.
 *
 * A near-mechanical port of the Firestore binding — same tenancy rules, same
 * validate-and-skip on a bad row, same defaults. Three things genuinely
 * changed, and each is a place the Firestore version was working around its
 * store rather than expressing intent:
 *
 * 1. **Cursor pagination is keyset**, not `startAfter(snapshot)`.
 * 2. **The transcript batch lookup is one statement**, not 30-item chunks
 *    fanned out with `Promise.all` (`FIRESTORE_IN_LIMIT` is gone).
 * 3. **`savePost` is one upsert** rather than a whole-document `set`, so a save
 *    cannot clobber a concurrently-written `processing` column.
 */

const SELECT_COLS = 'record, processing, lease_until';

/**
 * Keyset pagination.
 *
 * The Firestore binding fetched the cursor document, then passed the snapshot
 * to `startAfter`. Here the cursor resolves inside the same statement as a CTE,
 * so paginating costs one round trip rather than two — which matters more on
 * Neon-over-HTTP than it did on Firestore.
 *
 * **A cursor pointing at a row that does not exist is IGNORED**, matching
 * `startAfterCursor`'s `snap.exists ? … : q`. That is the reason for the
 * `not exists` arm: without it, `(created_at, id) < (select … )` against an
 * empty subquery yields NULL, which filters out every row — turning a stale
 * cursor from "start over" into "silently empty page".
 *
 * Ordering is `(created_at, id)` rather than `created_at` alone so the sort is
 * total. Both are server-assigned in the same `create` call (`deps.now()` and
 * `newPostId()`), and ids are TIDs, so the tuple is monotonic — but ties in a
 * millisecond are still possible and an unstable sort would drop or repeat rows
 * across pages.
 */
function paginated(where: string, direction: 'asc' | 'desc'): string {
    const cmp = direction === 'desc' ? '<' : '>';
    return `
        with cursor as (
            select created_at, id from posts where id = $CURSOR
        )
        select ${SELECT_COLS}
          from posts
         where ${where}
           and ($CURSOR::text is null
                or not exists (select 1 from cursor)
                or (created_at, id) ${cmp} (select created_at, id from cursor))
         order by created_at ${direction}, id ${direction}
         limit $LIMIT
    `;
}

/** Bind the two named placeholders to positional ones after the caller's own params. */
function bind(template: string, firstParam: number): string {
    return template
        .replaceAll('$CURSOR', `$${firstParam}`)
        .replaceAll('$LIMIT', `$${firstParam + 1}`);
}

export function postgresAudioPostDependencies(sql: SqlClient): AudioPostDependencies {
    return {
        // Unchanged from the Firestore binding: a TID is the `rkey` in
        // at://{appDid}/{collection}/{rkey}, so it must be an honest AT-Proto
        // record key regardless of what stores it.
        newPostId(): string {
            return newTid();
        },

        getAppDid(originAppId: string): string {
            return resolveAppDid(originAppId);
        },

        async savePost(record: AudioPostRecord): Promise<void> {
            const split = splitRecord(record);
            // `processing` and `lease_until` are only overwritten when the
            // record being saved actually carries processing state. A create
            // without it must not null out a column the processing worker owns
            // — the Firestore binding's whole-document `set` had exactly that
            // hazard, and only avoided it because callers always passed the
            // full record.
            await sql.query(
                `
                insert into posts (id, origin_app_id, record, processing, lease_until, created_at)
                values ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
                on conflict (id) do update
                    set record       = excluded.record,
                        created_at   = excluded.created_at,
                        processing   = coalesce(excluded.processing, posts.processing),
                        lease_until  = coalesce(excluded.lease_until, posts.lease_until)
                `,
                [
                    record.id,
                    record.originAppId,
                    JSON.stringify(split.record),
                    split.processing ? JSON.stringify(split.processing) : null,
                    split.leaseUntil,
                    split.createdAt,
                ],
            );
        },

        async getPostById(originAppId: string, id: string): Promise<AudioPostRecord | null> {
            if (!id?.trim()) return null;
            // Tenancy is a predicate, not a post-read check: a post owned by
            // another origin app is invisible, and doing it in SQL means it can
            // never be forgotten by a later edit.
            const rows = await sql.query<PostRow>(
                `select ${SELECT_COLS} from posts where id = $1 and origin_app_id = $2`,
                [id, originAppId],
            );
            return rows.length > 0 ? hydrateRows(rows)[0] ?? null : null;
        },

        async queryByAuthor(
            originAppId: string,
            authorId: string,
            options?: AudioPostQueryOptions,
        ): Promise<AudioPostRecord[]> {
            if (!originAppId?.trim() || !authorId?.trim()) return [];
            const { kind, limit = 20, cursorId } = options ?? {};

            const params: unknown[] = [originAppId, authorId];
            let where = 'origin_app_id = $1 and author_id = $2';
            if (kind) {
                params.push(kind);
                where += ` and kind = $${params.length}`;
            }
            params.push(cursorId ?? null, limit);
            const rows = await sql.query<PostRow>(
                bind(paginated(where, 'desc'), params.length - 1),
                params,
            );
            return hydrateRows(rows);
        },

        async queryByRootAuthor(
            originAppId: string,
            rootAuthorId: string,
            options?: AudioPostQueryOptions,
        ): Promise<AudioPostRecord[]> {
            if (!originAppId?.trim() || !rootAuthorId?.trim()) return [];
            const { limit = 20, cursorId } = options ?? {};
            // `root_author_id` is stamped on replies only, so this is
            // inherently reply-scoped — no `kind` predicate, same as Firestore.
            // The partial index carries the `kind = 'reply'` restriction.
            const rows = await sql.query<PostRow>(
                bind(paginated('origin_app_id = $1 and root_author_id = $2', 'desc'), 3),
                [originAppId, rootAuthorId, cursorId ?? null, limit],
            );
            return hydrateRows(rows);
        },

        async queryReplies(
            originAppId: string,
            parentUri: string,
            options?: AudioPostThreadOptions,
        ): Promise<AudioPostRecord[]> {
            if (!originAppId?.trim() || !parentUri?.trim()) return [];
            const { limit = 50, cursorId } = options ?? {};
            // Ascending — thread reading order.
            const rows = await sql.query<PostRow>(
                bind(paginated('origin_app_id = $1 and reply_parent_uri = $2', 'asc'), 3),
                [originAppId, parentUri, cursorId ?? null, limit],
            );
            return hydrateRows(rows);
        },

        async getTranscriptsBySubjectUris(
            uris: string[],
        ): Promise<Map<string, TranscriptEnrichmentRecord>> {
            const map = new Map<string, TranscriptEnrichmentRecord>();
            const unique = Array.from(new Set(uris.filter((u) => u?.trim())));
            if (unique.length === 0) return map;

            // One statement. The Firestore binding chunked at 30 (`in` query
            // cap) and fanned out with Promise.all; `= any($1)` has no such
            // limit, so the chunking, the fan-out, and the constant are gone.
            const rows = await sql.query<{ record: unknown }>(
                `select record from audio_transcripts where subject_uri = any($1)`,
                [unique],
            );

            for (const row of rows) {
                const parsed = TranscriptEnrichmentRecordSchema.safeParse(row.record);
                if (!parsed.success) {
                    logger.error(
                        { issues: parsed.error.issues },
                        '[postgres] transcript enrichment validation failed; skipping',
                    );
                    continue;
                }
                map.set(parsed.data.subject.uri, parsed.data);
            }
            return map;
        },

                resolveAudioUrl(originAppId: string, blobCid: string): Promise<string | null> {
            // No storage call: the proxy URL is derived from the tenancy + CID,
            // so hydrating a post no longer costs a signing round trip per
            // audio embed.
            return Promise.resolve(audioPlaybackUrl(originAppId, blobCid));
        },

        cidForRecord,

        now(): Date {
            return new Date();
        },
    };
}
