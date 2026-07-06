import { z } from 'zod';
import { AudioEmbedSchema, ReplyRefSchema } from './types/audio';
import { ProcessingRequestSchema } from './types/processing';
import { httpsUrl } from './types/records';

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
  langs: z.array(z.string()).max(3).optional(),
  /** Author self-label values (content warnings). */
  selfLabels: z.array(z.string()).optional(),
  /**
   * Opt-in audio processing for this post's audio (transcribe / denoise).
   * Both default off. Stages the deployment can't provide come back marked
   * `skipped` on the view rather than failing the create. See
   * `types/processing.ts`.
   */
  processing: ProcessingRequestSchema.optional(),
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
 * Update-request codec for the authenticated actor's own profile
 * (`PATCH /api/v1/users/me`). Partial-update of identity fields only.
 */
export const UpdateProfileRequestSchema = z.object({
  handle: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/).optional(),
  displayName: z.string().max(50).optional(),
  bio: z.string().max(160).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  usageIntent: z.string().max(200).nullable().optional(),
  /**
   * Personal website surfaced on the public profile. Accepts a URL, empty
   * string, or null from the client; normalizes empty string → null.
   *
   * Validated with `httpsUrl()` — the SAME refinement `UserRecordSchema`
   * applies on read. The write codec must never be laxer than the read
   * schema: a bare `.url()` here accepts `javascript:`/`data:` values that
   * bypass the stored-XSS hardening and then fail `UserRecordSchema`
   * parsing on every subsequent read of the record.
   */
  website: z.union([httpsUrl(), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v === '' ? null : v)),
  /** Up to 5 public links (label + URL) shown under the bio. http(s)-only,
   *  matching `UserRecordSchema.links` (see `website` note above). */
  links: z.array(z.object({
    label: z.string().min(1).max(40),
    url: httpsUrl(),
  })).max(5).optional(),
  /** When true, surfaces the linked Bluesky identity on the public profile. */
  showBlueskyPublicly: z.boolean().optional(),
});
