import { z } from 'zod';
import { ProfileViewBasicSchema } from './views';

// #region DTOs (Public API Contracts)
// =================================================================================================

/**
 * Public Profile DTO — the public-facing profile shape returned by the
 * `/users` discovery list. Same shape as `ProfileViewBasicSchema` (the
 * `bluesky` re-extend is kept only so the DTO name survives in the OpenAPI
 * output for that route).
 */
export const PublicProfileDtoSchema = ProfileViewBasicSchema.extend({
    bluesky: z.object({
        handle: z.string(),
        did: z.string(),
    }).optional(),
});
export type PublicProfileDto = z.infer<typeof PublicProfileDtoSchema>;

// #endregion

