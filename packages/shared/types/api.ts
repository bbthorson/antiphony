import { z } from 'zod';
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
});
export type PublicProfileDto = z.infer<typeof PublicProfileDtoSchema>;

/**
 * Actor View — the full view returned to the authenticated user about themselves.
 * Uses ProfileViewSelfSchema which includes private settings but not admin fields.
 */
export const ActorViewSchema = ProfileViewSelfSchema;
export type ActorView = z.infer<typeof ActorViewSchema>;

// #endregion

