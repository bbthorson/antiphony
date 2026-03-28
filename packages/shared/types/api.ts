import { z } from 'zod';
import { FirestoreTimestampSchema } from './records';
import { ProfileViewBasicSchema, ProfileViewSelfSchema } from './views';

// #region DTOs (Public API Contracts)
// =================================================================================================

/**
 * Public Profile DTO — the public-facing profile shape.
 * Equivalent to ProfileViewBasicSchema plus a few enrichment fields.
 */
export const PublicProfileDtoSchema = ProfileViewBasicSchema.extend({
    bluesky: z.object({
        handle: z.string(),
        did: z.string(),
    }).optional(),
    rssFeedUrl: z.string().nullable().optional(),
});
export type PublicProfileDto = z.infer<typeof PublicProfileDtoSchema>;

/**
 * Public Reply DTO
 * Excludes internal fields or sensitive metadata if any.
 */
export const PublicReplyDtoSchema = z.object({
    id: z.string(),
    audioUrl: z.string().url(),
    duration: z.number().optional(),
    createdAt: FirestoreTimestampSchema,
    transcription: z.string().optional(),
    sentiment: z.enum(['Positive', 'Negative', 'Neutral']).optional(),
    aiSummary: z.string().optional(),
    author: PublicProfileDtoSchema,
});
export type PublicReplyDto = z.infer<typeof PublicReplyDtoSchema>;

/**
 * Actor View — the full view returned to the authenticated user about themselves.
 * Uses ProfileViewSelfSchema which includes private settings but not admin fields.
 */
export const ActorViewSchema = ProfileViewSelfSchema;
export type ActorView = z.infer<typeof ActorViewSchema>;

// #endregion

