import { z } from 'zod';
import { AudioEmbedSchema, ReplyRefSchema } from './types/audio';

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
   * string, or null from the client; normalizes empty string → null so the
   * value stored on `UserRecord` (which requires `.url() | null`) round-trips
   * cleanly through `UserRecordSchema.parse` on subsequent reads.
   */
  website: z.union([z.string().url(), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v === '' ? null : v)),
  /** Up to 5 public links (label + URL) shown under the bio. */
  links: z.array(z.object({
    label: z.string().min(1).max(40),
    url: z.string().url(),
  })).max(5).optional(),
  /** When true, surfaces the linked Bluesky identity on the public profile. */
  showBlueskyPublicly: z.boolean().optional(),
});
