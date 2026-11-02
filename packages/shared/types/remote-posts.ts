import { z } from 'zod';
import { AudioEmbedViewSchema, PostRecordPublicSchema, ReplyRefSchema, StrongRefSchema } from './audio';
import { DidStringSchema } from './dids';
import { ProcessingRequestSchema } from './processing';
import { SpaceKeySchema } from './spaces';

/**
 * **Remote posts** (specs/audio-service-mode.md): `dev.antiphony.audio.post`
 * records that live in a repo Antiphony doesn't host, such as a player's PDS
 * or a group's repo on its group host. A tenant registers one by URI and CID;
 * Antiphony fetches the record from where the URI says it lives, copies and
 * processes its audio, and serves it. Phase A covers public repo records;
 * Phase B adds space records, whose body and bytes the tenant pushes.
 *
 * Light checks only, so this package stays dependency-free; `@antiphony/core`
 * parses the URI with its own rules before anything is fetched.
 */

/**
 * A remote post's URI: a repo record, `at://{did}/{collection}/{rkey}`, or a
 * space record, `at://{authority}/space/{type}/{skey}/{authorDid}/{collection}/{rkey}`.
 */
export const RemotePostUriSchema = StrongRefSchema.shape.uri;

/**
 * A space held outside Antiphony, as a URI: `at://{authority}/space/{type}/{skey}`.
 * The authority is the group's DID; it is never registered here.
 */
export const RemoteSpaceUriSchema = z
    .string()
    .max(512)
    .regex(/^at:\/\/did:[a-z]+:[^/]+\/space\/[^/]+\/[^/]+$/, 'Must be at://{did}/space/{type}/{skey}');

/** A space held outside Antiphony: its authority's DID, type and key. */
export const RemoteSpaceSchema = SpaceKeySchema.extend({ authority: DidStringSchema });
export type RemoteSpace = z.infer<typeof RemoteSpaceSchema>;

/**
 * Where Antiphony gets a registered record and its bytes:
 *  - `fetch`: from the repo the URI names. The default for a repo record, and
 *    the only way a repo record is read.
 *  - `upload`: the bytes are an earlier `POST /api/v1/audio/upload` of this
 *    tenant, and nothing is downloaded. The default for a space record, which
 *    Antiphony can't read: the tenant sends the record in `record` too.
 */
export const RemoteBytesFromSchema = z.enum(['fetch', 'upload']);
export type RemoteBytesFrom = z.infer<typeof RemoteBytesFromSchema>;

/** `PUT /api/v1/remote-posts`: register a record held elsewhere. */
export const RegisterRemotePostRequestSchema = z.object({
    /** The record's URI. Antiphony fetches a repo record from the repo the URI names. */
    uri: RemotePostUriSchema,
    /**
     * The record CID the tenant expects. Antiphony recomputes the CID of the
     * record it fetched (or, for a space record, of `record`), and refuses a
     * mismatch.
     */
    cid: z.string().min(1).max(128),
    /** Opt into processing stages, as on `POST /api/v1/posts`. */
    processing: ProcessingRequestSchema.optional(),
    /** Where the bytes come from; defaults by URI (see `RemoteBytesFromSchema`). */
    bytesFrom: RemoteBytesFromSchema.optional(),
    /**
     * The record as the tenant read it, in atproto's JSON form (`$link` for
     * the blob ref). Required for a space record and refused for a repo
     * record, which Antiphony reads itself. It must hash to `cid`.
     */
    record: z.record(z.string(), z.unknown()).optional(),
});
export type RegisterRemotePostRequest = z.infer<typeof RegisterRemotePostRequestSchema>;

/** `PATCH /api/v1/remote-posts?uri=`: request processing after registration. */
export const PatchRemotePostRequestSchema = z.object({
    processing: ProcessingRequestSchema,
});
export type PatchRemotePostRequest = z.infer<typeof PatchRemotePostRequestSchema>;

/**
 * The record as fetched: the `dev.antiphony.audio.post` lexicon, as a PDS
 * returns it. Unknown fields are kept (a lexicon may gain optional fields), and
 * the record must carry a `dev.antiphony.embed.audio` embed: a registration is
 * for audio.
 */
export const RemoteAudioPostRecordSchema = z
    .object({
        $type: z.literal('dev.antiphony.audio.post'),
        text: z.string().max(3000),
        title: z.string().max(3000).optional(),
        embed: z
            .object({
                $type: z.literal('dev.antiphony.embed.audio'),
                audio: z.object({
                    $type: z.literal('blob'),
                    ref: z.object({ $link: z.string().min(1).max(128) }),
                    mimeType: z.string().max(256),
                    size: z.number().int().min(0),
                }),
                durationMs: z.number().int().min(0).optional(),
                alt: z.string().max(10000).optional(),
                waveform: z.array(z.number().int().min(0).max(100)).max(1000).optional(),
            })
            .loose(),
        reply: ReplyRefSchema.optional(),
        langs: z.array(z.string()).max(3).optional(),
        labels: z
            .object({
                values: z.array(z.object({ val: z.string().max(128) }).loose()).max(10),
            })
            .loose()
            .optional(),
        createdAt: z.string().max(64).refine((s) => !Number.isNaN(Date.parse(s)), 'Must be a datetime'),
    })
    .loose();
export type RemoteAudioPostRecord = z.infer<typeof RemoteAudioPostRecordSchema>;

/**
 * A remote post as the API returns it. Not `AudioPostView`: a remote post has
 * no hosted `id` (rkey) and no `authorId` facet. Its author is the DID whose
 * repo holds it.
 */
export const RemotePostViewSchema = z.object({
    uri: RemotePostUriSchema,
    cid: z.string(),
    kind: z.enum(['prompt', 'reply']),
    /** The DID whose repo holds the record: the URI's authority, or a space record's author segment. */
    authorDid: DidStringSchema,
    /** The space the record is in, when it's a space record. Its audio plays from signed URLs only. */
    space: RemoteSpaceSchema.optional(),
    /**
     * How Antiphony checked the record. `fetched`: it read the record and its
     * blob from the source itself. `pushed`: the tenant sent them, and
     * Antiphony checked only that they hash to the registered CID and blob
     * ref. That proves content, not that the tenant could read the space.
     */
    verified: z.enum(['fetched', 'pushed']),
    /**
     * How a deletion of the source record reaches Antiphony. `sweep`: Antiphony
     * rechecks the record hourly, and the tenant's DELETE is faster. `tenant`:
     * Antiphony can't read the record, so the tenant's DELETE is the only
     * signal; a tenant that can't commit to sending it shouldn't register a
     * member's record this way.
     */
    deletionCheck: z.enum(['sweep', 'tenant']),
    record: PostRecordPublicSchema,
    /**
     * Playback, transcript and processing, as for a hosted post. Absent while
     * the post is unavailable.
     */
    embed: AudioEmbedViewSchema.optional(),
    /**
     * False when the record's repo has been unreachable for 30 days: the post
     * is kept but not served (specs/audio-service-mode.md §8.1).
     */
    available: z.boolean(),
    /** When this tenant registered it (ISO 8601). */
    registeredAt: z.string(),
});
export type RemotePostView = z.infer<typeof RemotePostViewSchema>;

/** `GET /api/v1/remote-posts/thread?root=`: the registered replies under a root. */
export const RemoteThreadViewSchema = z.object({
    /** The root, when it's a registered remote post. On the first page only. */
    root: RemotePostViewSchema.nullable(),
    replies: z.array(RemotePostViewSchema),
    /** Pass as `cursor` for the next page; null on the last. */
    nextCursor: z.string().nullable(),
});
export type RemoteThreadView = z.infer<typeof RemoteThreadViewSchema>;

/** `DELETE /api/v1/remote-posts?uri=`: whether a registration was removed. */
export const DeleteRemotePostResultSchema = z.object({
    uri: RemotePostUriSchema,
    deleted: z.boolean(),
});
export type DeleteRemotePostResult = z.infer<typeof DeleteRemotePostResultSchema>;
