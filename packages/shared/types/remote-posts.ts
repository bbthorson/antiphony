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
 * processes its audio, and serves it. Phase A covers public repo records.
 * Phase B adds space records whose body and bytes the tenant pushes, and
 * Phase C space records Antiphony reads itself on a member's delegation.
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
 * Where Antiphony gets a registered record's bytes:
 *  - `fetch`: from the repo the URI names. The default for a repo record, and
 *    for a space record registered with a `delegationToken`.
 *  - `upload`: the bytes are an earlier `POST /api/v1/audio/upload` of this
 *    tenant, and nothing is downloaded. The default for a space record pushed
 *    with its `record` body.
 */
export const RemoteBytesFromSchema = z.enum(['fetch', 'upload']);
export type RemoteBytesFrom = z.infer<typeof RemoteBytesFromSchema>;

/** A space token as it travels: a compact JWS. Checked by whoever verifies it. */
const SpaceTokenSchema = z.string().min(16).max(8192).regex(/^[\w-]+\.[\w-]+\.[\w-]+$/, 'Must be a JWT');

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
     * the blob ref), for a space record the tenant pushes. It must hash to
     * `cid`. Refused for a repo record, and beside a `delegationToken`:
     * Antiphony reads the record itself then.
     */
    record: z.record(z.string(), z.unknown()).optional(),
    /**
     * For a space record: a delegation token from a member's PDS
     * (`com.atproto.space.getDelegationToken`), so Antiphony reads the record
     * and its blob from the writer's PDS itself. Single use and short-lived
     * (60 s), so send it as soon as it's minted. The member must hold a role
     * that can read the space.
     */
    delegationToken: SpaceTokenSchema.optional(),
    /**
     * A client attestation from the tenant's OAuth client, for a space whose
     * policy only admits listed apps. Sent with `delegationToken`.
     */
    clientAttestation: SpaceTokenSchema.optional(),
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
     * How a deletion of the source record reaches Antiphony:
     *  - `sweep`: Antiphony rechecks a repo record hourly by itself. The
     *    tenant's DELETE is faster.
     *  - `recheck`: a space record Antiphony read on a delegation. A credential
     *    doesn't outlive ten minutes, so Antiphony asks the tenant for a fresh
     *    delegation hourly (`remote.recheck_requested`) and rechecks when the
     *    tenant answers (`POST /api/v1/remote-posts/recheck`).
     *  - `tenant`: a pushed space record Antiphony hasn't read, so the
     *    tenant's DELETE is the only signal until a recheck reads it. A tenant
     *    that can't commit to sending it shouldn't register a member's record
     *    this way.
     */
    deletionCheck: z.enum(['sweep', 'recheck', 'tenant']),
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

/** The most URIs one `getRemotePosts` call takes, as `app.bsky.feed.getPosts` does. */
export const MAX_REMOTE_POSTS_BATCH = 25;

/**
 * `dev.antiphony.audio.listRemotePosts`: one page of a tenant's registered
 * remote posts, newest first. Shaped as atproto lists are (a named array and
 * `cursor`), not as the older REST lists (`items` / `nextCursor`).
 */
export const RemotePostListViewSchema = z.object({
    posts: z.array(RemotePostViewSchema),
    /** Pass as `cursor` for the next page. Absent on the last page. */
    cursor: z.string().optional(),
});
export type RemotePostListView = z.infer<typeof RemotePostListViewSchema>;

/**
 * `dev.antiphony.audio.getRemotePosts`: the registered posts among the URIs
 * asked for, in request order. Unregistered URIs are left out.
 */
export const RemotePostsViewSchema = z.object({
    posts: z.array(RemotePostViewSchema),
});
export type RemotePostsView = z.infer<typeof RemotePostsViewSchema>;

/** `DELETE /api/v1/remote-posts?uri=`: whether a registration was removed. */
export const DeleteRemotePostResultSchema = z.object({
    uri: RemotePostUriSchema,
    deleted: z.boolean(),
});
export type DeleteRemotePostResult = z.infer<typeof DeleteRemotePostResultSchema>;

/**
 * `POST /api/v1/remote-posts/recheck`: recheck this tenant's registered
 * records in one space against their writers' PDSes, on a fresh delegation.
 */
export const RecheckRemoteSpaceRequestSchema = z.object({
    /** The space, `at://{authority}/space/{type}/{skey}`. */
    space: RemoteSpaceUriSchema,
    /** A fresh delegation from a member who can read the space. Single use. */
    delegationToken: SpaceTokenSchema,
    /** For a space that only admits listed apps. */
    clientAttestation: SpaceTokenSchema.optional(),
});
export type RecheckRemoteSpaceRequest = z.infer<typeof RecheckRemoteSpaceRequestSchema>;

/** What one recheck did. */
export const RecheckRemoteSpaceResultSchema = z.object({
    space: RemoteSpaceUriSchema,
    /** Rows read against their source. */
    checked: z.number().int().min(0),
    /** Rows removed because their record (or the whole space) is gone. */
    removed: z.number().int().min(0),
    /** Rows that took an edit. */
    changed: z.number().int().min(0),
    /**
     * Whether rows in this space are still due. A credential lasts ten
     * minutes and one call checks a bounded number of rows, so call again
     * with another delegation.
     */
    remaining: z.boolean(),
});
export type RecheckRemoteSpaceResult = z.infer<typeof RecheckRemoteSpaceResultSchema>;
