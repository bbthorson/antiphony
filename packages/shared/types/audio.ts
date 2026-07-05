import { z } from 'zod';
import { BlobRefSchema } from './blob';
import { FirestoreTimestampSchema } from './records';
import { ProcessingStateSchema, ProcessingViewSchema } from './processing';

/**
 * Antiphony canonical audio-post contract (`dev.antiphony.*`).
 *
 * Mirrors the lexicons in `lexicons/dev/antiphony/`. Key model decisions:
 *  - ONE post collection; `reply` presence discriminates prompt-vs-reply.
 *  - The audio is a standard `embed.audio`; transcript is platform enrichment
 *    (separate record), lifted into the embed *view* at read time.
 *  - "blob" in the lexicon ⇒ a storage ref on the record (`BlobRef`); the view
 *    carries a resolved/signed playback URL.
 *  - Tenancy (`originAppId`) + facets (`authorId`, `orgId`) are storage-layer
 *    indexed fields, NOT part of the public lexicon.
 */

// #region Shared primitives

/**
 * AT Protocol StrongRef — a content-addressed, portable pointer to another
 * record (`com.atproto.repo.strongRef`). Replaces the legacy flat `promptId`.
 */
export const StrongRefSchema = z.object({
    uri: z.string().regex(/^at:\/\/.+/, 'Must be an at:// URI'),
    cid: z.string(),
});
export type StrongRef = z.infer<typeof StrongRefSchema>;

/**
 * Threading pointers for a reply. `root` = the prompt at the top of the
 * thread; `parent` = the post being directly answered. Presence on a post is
 * the prompt-vs-reply discriminator.
 */
export const ReplyRefSchema = z.object({
    root: StrongRefSchema,
    parent: StrongRefSchema,
});
export type ReplyRef = z.infer<typeof ReplyRefSchema>;

// #endregion

// #region Audio embed (record + view)

/**
 * `dev.antiphony.embed.audio` — STORED shape. Holds the audio blob and its
 * render-independent metadata. Does NOT carry the transcript (that's the
 * enrichment record, lifted into the view).
 */
export const AudioEmbedSchema = z.object({
    $type: z.literal('dev.antiphony.embed.audio'),
    /** The audio bytes as a content-addressed blob ref (`ref.$link` = CID). */
    audio: BlobRefSchema,
    /** Duration in MILLISECONDS (platform-wide unit; not seconds). */
    durationMs: z.number().int().min(0).optional(),
    /** User-authored short description (audio analogue of image alt). NOT the transcript. */
    alt: z.string().max(10000).optional(),
    /** Pre-computed waveform peaks (normalized 0–100) for instant rendering. */
    waveform: z.array(z.number().int().min(0).max(100)).max(1000).optional(),
});
export type AudioEmbed = z.infer<typeof AudioEmbedSchema>;

/**
 * One time-coded transcript segment (the audio analogue of a WebVTT cue).
 */
export const TranscriptSegmentSchema = z.object({
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    text: z.string(),
}).refine((s) => s.endMs >= s.startMs, {
    message: 'endMs must be >= startMs',
    path: ['endMs'],
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

/**
 * A timed transcript: ordered segments + an optional concatenated rollup for
 * consumers that don't need timing. The shape both the enrichment record and
 * the embed view carry.
 */
export const TimedTranscriptSchema = z.object({
    segments: z.array(TranscriptSegmentSchema),
    text: z.string().optional(),
});
export type TimedTranscript = z.infer<typeof TimedTranscriptSchema>;

/**
 * `dev.antiphony.embed.audio#view` — HYDRATED shape. Carries a resolved,
 * playable URL (a signed Storage URL in the centralized deployment) and the
 * transcript lifted from the enrichment record at read time.
 */
export const AudioEmbedViewSchema = z.object({
    $type: z.literal('dev.antiphony.embed.audio#view'),
    url: z.string().url(),
    durationMs: z.number().int().min(0).optional(),
    // `alt`/`waveform` are copied from the stored embed; keep the same bounds
    // so a view can never carry a larger payload than the record allows.
    alt: z.string().max(10000).optional(),
    waveform: z.array(z.number().int().min(0).max(100)).max(1000).optional(),
    /** Lifted from the transcript enrichment record; absent until transcription completes. */
    transcript: TimedTranscriptSchema.optional(),
    /**
     * Per-stage audio-processing status (transcribe / denoise), when the app
     * opted into processing on create. Absent otherwise. A `pending` stage
     * means the client should poll (or re-render) for the result. When
     * `denoise === 'ready'`, `url` above already resolves to the cleaned
     * audio variant. See `types/processing.ts`.
     */
    processing: ProcessingViewSchema.optional(),
});
export type AudioEmbedView = z.infer<typeof AudioEmbedViewSchema>;

// #endregion

// #region Canonical post record (stored)

/**
 * `dev.antiphony.audio.post` — the single canonical content record, as stored.
 *
 * = the lexicon fields (`text`, `title?`, `embed?`, `reply?`, `langs?`,
 * `selfLabels?`, `createdAt`) PLUS storage-layer indexed fields that are NOT
 * in the public lexicon (`id`, `originAppId`, `authorId`, `authorDid?`,
 * `orgId?`, `kind`). `kind` is denormalized from `reply` presence at write
 * time so "list an author's prompts" is a cheap composite-index query.
 */
export const AudioPostRecordSchema = z.object({
    /** Storage id (rkey/doc id). */
    id: z.string(),
    /**
     * Content CID of the canonical lexicon record (CIDv1, dag-cbor, sha2-256
     * — the AT Protocol record-CID rule). Computed at write time over the
     * lexicon projection (public fields only, NOT the storage/tenancy fields
     * below), so StrongRefs built from it are verifiable content addresses.
     */
    cid: z.string(),

    // --- Tenancy + facets (storage-indexed; NOT in the lexicon) ---
    /** Origin app that created this record — the multi-tenant isolation key. */
    originAppId: z.string(),
    /** Authoring user. A queryable facet, not the tenancy boundary. */
    authorId: z.string(),
    /** Optional AT Protocol identity of the author (facet). */
    authorDid: z.string().optional(),
    /** Optional org context (facet). */
    orgId: z.string().nullable().optional(),
    /** Denormalized from `reply` presence: `reply` set ⇒ 'reply', else 'prompt'. */
    kind: z.enum(['prompt', 'reply']),
    /**
     * Branch participant pair (author ids) for reply gating — the parties to a
     * reply's sub-thread: the creator (thread-root author) + the responder who
     * opened the branch. Set on replies (deduped, 1–2 ids); absent on prompts
     * (a prompt's repliers are the app's audience policy, not a fixed pair).
     * Inherited down the branch so reply gating is an O(1) field check, never a
     * thread walk.
     */
    threadParticipants: z.array(z.string()).optional(),
    /**
     * Async audio-processing state (transcribe / denoise), present iff the app
     * opted into processing on create. Mutated by the processing worker after
     * the post is created — storage-layer, NOT in the lexicon or the record
     * CID. See `types/processing.ts`.
     */
    processing: ProcessingStateSchema.optional(),

    // --- Lexicon fields (public contract) ---
    /** User-authored text (bsky-semantic). May be empty for pure-audio posts. NEVER the transcript. */
    text: z.string().max(3000),
    /** Optional headline; a prompt feature, not the discriminator. */
    title: z.string().max(3000).optional(),
    /** Audio (or other) attachment. Audio posts carry an `AudioEmbed`. */
    embed: AudioEmbedSchema.optional(),
    /** Present iff this post is a reply (StrongRef root + parent). */
    reply: ReplyRefSchema.optional(),
    /** BCP-47 language tags for the text. */
    langs: z.array(z.string()).max(3).optional(),
    /** Author-applied self-label values (content warnings). Simplified from the
     *  lexicon's `com.atproto.label.defs#selfLabels` to the bare value strings. */
    selfLabels: z.array(z.string()).optional(),
    createdAt: FirestoreTimestampSchema,
}).refine(
    // `kind` is denormalized from `reply` presence at write time; enforce the
    // invariant so an inconsistent record can't be written or read silently.
    // A reply has `reply` and no `title`; a prompt has neither a `reply`.
    (r) => (r.kind === 'reply' ? !!r.reply && r.title === undefined : !r.reply),
    {
        message: "kind must match reply presence: 'reply' ⇒ reply set & no title; 'prompt' ⇒ no reply",
        path: ['kind'],
    },
);
export type AudioPostRecord = z.infer<typeof AudioPostRecordSchema>;

/**
 * `dev.antiphony.audio.transcript` — platform-enrichment record. Stored in the
 * Antiphony enrichment namespace, referencing the post by StrongRef. Lifted
 * into `AudioEmbedView.transcript` during hydration; never on the post.
 */
export const TranscriptEnrichmentRecordSchema = z.object({
    id: z.string(),
    /** The post whose audio this transcribes. */
    subject: StrongRefSchema,
    transcript: TimedTranscriptSchema,
    /** BCP-47 language tag of the transcript. */
    lang: z.string().optional(),
    /** Model/provider provenance (the generator is a pluggable port). */
    model: z.string().optional(),
    createdAt: FirestoreTimestampSchema,
});
export type TranscriptEnrichmentRecord = z.infer<typeof TranscriptEnrichmentRecordSchema>;

/**
 * `dev.antiphony.actor.profile` — port of `com.voxpop.actor.profile`.
 */
export const ActorProfileRecordSchema = z.object({
    handle: z.string().min(3).max(20).optional(),
    usageIntent: z.string().max(100).optional(),
    rssFeed: z.string().url().optional(),
});
export type ActorProfileRecord = z.infer<typeof ActorProfileRecordSchema>;

// #endregion

// #region Hydrated post view (record + viewer state)

/**
 * Per-viewer relationship to a post, computed from the caller's auth (the
 * bsky `#viewerState` pattern). Lives on the VIEW, never the record. Starts
 * minimal; like/seen are added when those features exist.
 */
export const ViewerStateSchema = z.object({
    /** True when the authenticated caller authored this post. */
    isAuthor: z.boolean().default(false),
    /**
     * Whether the caller may reply to this post (reply gating, §6). A prompt is
     * repliable by any authenticated viewer (the app's audience-policy default);
     * a reply only by its branch participants (`{ creator, branch responder }`).
     */
    canReply: z.boolean().default(false),
    /** Why `canReply` is false, when it is (omitted when the caller can reply). */
    replyDisabledReason: z.enum(['unauthenticated', 'not_a_participant']).optional(),
});
export type ViewerState = z.infer<typeof ViewerStateSchema>;

/**
 * The public, hydrated lexicon fields of a post (no storage/tenancy fields,
 * no stored embed — the embed comes hydrated on the view).
 */
export const PostRecordPublicSchema = z.object({
    text: z.string(),
    title: z.string().optional(),
    reply: ReplyRefSchema.optional(),
    langs: z.array(z.string()).optional(),
    selfLabels: z.array(z.string()).optional(),
    createdAt: FirestoreTimestampSchema,
});
export type PostRecordPublic = z.infer<typeof PostRecordPublicSchema>;

/**
 * `AudioPostView` — the hydrated, client-facing shape (the bsky `postView`
 * analogue): record content + opaque author references + hydrated embed +
 * per-viewer state. Produced by the (batched) hydrator; the default/public
 * view, with owner-extra arriving via `viewer` + separate authed endpoints,
 * not fat records.
 *
 * Author identity is carried as **opaque references**, never a hydrated
 * profile: `authorId` is the app's own user id (attribution facet) and
 * `authorDid` is present only when the caller asserted one. Antiphony holds no
 * user data — the caller BFF hydrates display identity by joining on
 * `authorId` (see specs/core-surface.md, "The author model").
 */
export const AudioPostViewSchema = z.object({
    /** at:// URI (or internal ref) identifying the post. */
    uri: z.string(),
    /** Content CID of the canonical record (see `AudioPostRecordSchema.cid`). */
    cid: z.string(),
    kind: z.enum(['prompt', 'reply']),
    /** The acting actor's app-scoped id — an opaque attribution ref, not a profile. */
    authorId: z.string(),
    /** The author's app-asserted AT Protocol DID, when the caller provided one. */
    authorDid: z.string().optional(),
    record: PostRecordPublicSchema,
    /** Hydrated audio embed (signed URL + lifted transcript). */
    embed: AudioEmbedViewSchema.optional(),
    viewer: ViewerStateSchema,
});
export type AudioPostView = z.infer<typeof AudioPostViewSchema>;

// #endregion
