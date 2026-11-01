import { z } from 'zod';
import { AudioEmbedSchema, ReplyRefSchema } from './types/audio';
import { ProcessingRequestSchema } from './types/processing';
import { RepliesPolicySchema } from './types/deletion';
import { SpaceAuthorSchema, SpaceKeySchema, SpacePolicySchema } from './types/spaces';
import { TenantDidRoleSchema } from './types/dids';
import { httpsUrl } from './types/url';

/**
 * Create-request codec for the canonical Antiphony `dev.antiphony.audio.post`
 * model. The audio is uploaded first (signed-URL flow); the request references
 * it as the embed. `reply` presence makes the new post a reply; absence makes
 * it a prompt. `originAppId`/`authorId`/`kind` are stamped server-side, not sent.
 */
export const CreateAudioPostRequestSchema = z.object({
  /** User-authored text; may be empty for pure-audio posts. */
  text: z.string().max(3000).default(''),
  /** Optional headline (prompt feature). */
  title: z.string().max(3000).optional(),
  /** The uploaded audio attachment. */
  embed: AudioEmbedSchema.optional(),
  /** Present ⇒ this is a reply (StrongRef root + parent). */
  reply: ReplyRefSchema.optional(),
  /** BCP-47 language tags. */
  langs: z.array(z.string().max(35)).max(3).optional(),
  /** Author self-label values (content warnings). */
  selfLabels: z.array(z.string().max(128)).max(10).optional(),
  /**
   * Opt-in audio processing for this post's audio (denoise / trim /
   * transcribe / waveform). All default off. Stages the deployment can't
   * provide come back marked `skipped` on the view rather than failing the
   * create. A multi-stage request runs denoise → trim → (transcribe,
   * waveform); request stages individually to override that order. See
   * `types/processing.ts`.
   */
  processing: ProcessingRequestSchema.optional(),
  /**
   * The space to create this post in (specs/spaces.md). It must exist for the
   * calling tenant (`PUT /api/v1/spaces/{type}/{skey}`), and the audio must have
   * been uploaded into the same space. A reply to a post in a space is always
   * created in that space: name it or omit it, but naming another is refused.
   * A reply to a flat post may name a space. Absent ⇒ a flat, public post (or,
   * for a reply, its parent's space).
   */
  space: SpaceKeySchema.optional(),
  /**
   * Whose DID is the author segment of a post in a space
   * (specs/audio-service-and-groups.md G5). `authority` (the default when
   * absent; optional rather than defaulted, so the request type stays
   * optional for clients that build it): the
   * space authority's DID, for what a publisher keeps or an app generates.
   * `actor`: the acting actor's DID (`X-Antiphony-Acting-Actor-Did`, which
   * must be a valid DID), for a member's own record. Only a post in a space has
   * an author segment, so `actor` on a flat post is refused.
   */
  spaceAuthor: SpaceAuthorSchema.optional(),
})
  // A reply is a caption on someone else's prompt — it carries no title.
  .refine((d) => !(d.reply && d.title), {
    message: 'Replies cannot have a title',
    path: ['title'],
  })
  // Reject completely empty posts: require text or an audio embed.
  .refine((d) => d.text.trim().length > 0 || !!d.embed, {
    message: 'Post must have text or an audio embed',
    path: ['text'],
  });
export type CreateAudioPostRequest = z.infer<typeof CreateAudioPostRequestSchema>;

/**
 * Patch-request codec for the canonical Antiphony `dev.antiphony.audio.post`
 * model. **Processing opt-in is the ONLY thing a PATCH may change** — it
 * re-triggers async audio enrichment (transcribe / denoise) on an existing
 * post. No lexicon fields are editable here: those feed the record CID (its
 * content address / identity), so a content edit would mint a different record.
 * Processing state is storage-layer, so this changes no CID. See
 * `types/processing.ts`.
 */
export const PatchAudioPostRequestSchema = z.object({
  /** Opt-in audio processing to (re)run for this post's audio. Required — a
   *  PATCH with no processing request is a no-op and rejected as invalid. */
  processing: ProcessingRequestSchema,
});
export type PatchAudioPostRequest = z.infer<typeof PatchAudioPostRequestSchema>;

/**
 * `PUT /api/v1/spaces/{type}/{skey}` — create or replace a space's policies.
 * The space's authority is always the calling tenant's own DID. Replacement,
 * not a merge: an omitted policy is reset to the protocol default
 * (`member-list`), so the same request always leaves the same space.
 */
export const PutSpaceRequestSchema = z.object({
  readPolicy: SpacePolicySchema.default('member-list'),
  writePolicy: SpacePolicySchema.default('member-list'),
  /**
   * Where `checkUserAccess` is called for `managing-app` policies, for apps
   * other than the tenant. Not needed while the tenant is the only reader.
   */
  managingAppEndpoint: httpsUrl().optional(),
});
export type PutSpaceRequest = z.infer<typeof PutSpaceRequestSchema>;

/**
 * `POST /api/v1/authors/{authorId}/erase` — account erasure. Deletes every post
 * the author wrote, applying `replies` to the subtrees below them, up to `limit`
 * posts per call. The author's own posts are always deleted: `replies` governs
 * other people's replies below them (specs/deletion.md § 4.2).
 */
export const EraseAuthorRequestSchema = z.object({
  replies: RepliesPolicySchema.default('delete'),
  limit: z.number().int().min(1).max(200).default(100),
});
export type EraseAuthorRequest = z.infer<typeof EraseAuthorRequestSchema>;

/**
 * `PUT /api/v1/dids/{did}` — register a DID the calling tenant may write under
 * besides its app DID (specs/did-plc-and-multi-did-tenancy.md §3). The DID's
 * document must name this deployment as its space host; Antiphony checks that
 * before keeping the registration. Repeating the same registration is a no-op.
 */
export const RegisterDidRequestSchema = z.object({
  /** What the DID is to the tenant. Only `group` today. */
  role: TenantDidRoleSchema,
  /** The tenant's own id for the group (a table id, an org id). Opaque to Antiphony. */
  subjectRef: z.string().min(1).max(256).optional(),
});
export type RegisterDidRequest = z.infer<typeof RegisterDidRequestSchema>;
