import { z } from 'zod';
import { AudioEmbedViewSchema, PostRecordPublicSchema, ReplyRefSchema, StrongRefSchema } from './audio';
import { DidStringSchema } from './dids';
import { ProcessingRequestSchema } from './processing';

/**
 * **Remote posts** (specs/audio-service-mode.md): `dev.antiphony.audio.post`
 * records that live in a repo Antiphony doesn't host, such as a player's PDS
 * or a group's repo on its group host. A tenant registers one by URI and CID;
 * Antiphony fetches the record from where the URI says it lives, copies and
 * processes its audio, and serves it. Phase A covers public repo records.
 *
 * Light checks only, so this package stays dependency-free; `@antiphony/core`
 * parses the URI with its own rules before anything is fetched.
 */

/** A plain record URI, `at://{did}/{collection}/{rkey}`. Phase A has no space records. */
export const RemotePostUriSchema = StrongRefSchema.shape.uri;

/** `PUT /api/v1/remote-posts`: register a record held elsewhere. */
export const RegisterRemotePostRequestSchema = z.object({
    /** The record's URI. Antiphony fetches it from the repo the URI names. */
    uri: RemotePostUriSchema,
    /**
     * The record CID the tenant expects. Antiphony recomputes the CID of the
     * record it fetched, and refuses a mismatch (the record changed since).
     */
    cid: z.string().min(1).max(128),
    /** Opt into processing stages, as on `POST /api/v1/posts`. */
    processing: ProcessingRequestSchema.optional(),
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
    /** The DID whose repo holds the record. */
    authorDid: DidStringSchema,
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
