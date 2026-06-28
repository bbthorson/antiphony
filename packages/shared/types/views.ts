import { z } from 'zod';
import { FirestoreTimestampSchema } from './records';

/**
 * Layered Profile Views
 * Each level extends the previous, adding more fields.
 * This ensures sensitive data is only included when appropriate.
 */

/** Public profile — safe to return to any caller. */
export const ProfileViewBasicSchema = z.object({
    id: z.string(),
    handle: z.string().nullable().optional(),
    // `displayName` and `bio` are `.nullable()` — Firestore stores `null` for
    // empty values on these fields (see users-dependencies.ts), and Zod's
    // `.optional()` alone rejects `null`. Consumers already use truthy
    // checks / `??` / `||`, so widening the type to include `null` is safe.
    displayName: z.string().nullable().optional(),
    avatarUrl: z.string().nullable().optional(),
    bio: z.string().nullable().optional(),
    /** Personal website link surfaced on the public profile. */
    website: z.string().nullable().optional(),
    /** Public links (label + URL) shown under the bio. */
    links: z.array(z.object({
        label: z.string(),
        url: z.string(),
    })).optional(),
    /**
     * AT Protocol identity, surfaced on the public profile only when the user
     * opts in (`UserRecord.showBlueskyPublicly === true`). Projection happens
     * in the user dependency layer; this schema simply allows the field.
     */
    bluesky: z.object({
        handle: z.string(),
        did: z.string(),
    }).optional(),
    stats: z.object({
        followers: z.number().default(0),
        following: z.number().default(0),
        prompts: z.number().default(0),
    }).optional(),
    badges: z.array(z.string()).optional(),
    isVerified: z.boolean().optional(),
    createdAt: FirestoreTimestampSchema.optional(),
});
export type ProfileViewBasic = z.infer<typeof ProfileViewBasicSchema>;

/**
 * Project a wider profile (detailed/self/admin) down to the ProfileViewBasic
 * shape. Use this wherever a public-facing response embeds a profile — it
 * keeps PII (email, phoneNumber, lastSeenAt, unreadReplyCount, settings) and
 * admin fields (blockedUsers, followers, following, reportCount, isBanned)
 * from crossing the public API boundary.
 */
export function toProfileViewBasic(profile: {
    id: string;
    handle?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    bio?: string | null;
    website?: string | null;
    links?: Array<{ label: string; url: string }>;
    bluesky?: { handle: string; did: string };
    /**
     * When `false` or absent, `bluesky` is stripped from the public projection
     * even if it's linked on the underlying record — surfacing the AT Protocol
     * identity publicly is opt-in.
     */
    showBlueskyPublicly?: boolean;
    stats?: { followers: number; following: number; prompts: number };
    badges?: string[];
    isVerified?: boolean;
    createdAt?: unknown;
}): ProfileViewBasic {
    const { id, handle, displayName, avatarUrl, bio, website, links, bluesky, showBlueskyPublicly, stats, badges, isVerified, createdAt } = profile;
    return {
        id, handle, displayName, avatarUrl, bio, website, links,
        bluesky: showBlueskyPublicly ? bluesky : undefined,
        stats, badges, isVerified, createdAt,
    } as ProfileViewBasic;
}

/** Authenticated viewer — includes enrichment data visible to other users. */
export const ProfileViewDetailedSchema = ProfileViewBasicSchema.extend({
    /** AT Protocol Identity link */
    bluesky: z.object({
        handle: z.string(),
        did: z.string(),
    }).optional(),

    usageIntent: z.string().nullable().optional(),
});
export type ProfileViewDetailed = z.infer<typeof ProfileViewDetailedSchema>;

/** Own profile — includes private settings and activity data. */
export const ProfileViewSelfSchema = ProfileViewDetailedSchema.extend({
    phoneNumber: z.string().nullable().optional(),
    email: z.string().optional(),
    lastSeenAt: FirestoreTimestampSchema.optional(),
    lastActiveAt: FirestoreTimestampSchema.optional(),
    unreadReplyCount: z.number().default(0),
    newReplierCount: z.number().default(0),
    /**
     * Account tier from UserRecord — surfaced on the self profile so the
     * client can gate paid features. Optional for legacy docs without the
     * field; consumers should treat missing as `'free'`.
     */
    tier: z.enum(['free', 'creator_pro']).optional(),
    /**
     * Surfaces the linked Bluesky identity (handle + DID) on the public profile
     * when true. Persisted on UserRecord; exposed in self/detailed views so the
     * settings form can render the toggle's current state.
     */
    showBlueskyPublicly: z.boolean().optional(),
    settings: z.object({
        notifications: z.boolean().optional(),
        theme: z.string().optional(),
    }).optional(),
});
export type ProfileViewSelf = z.infer<typeof ProfileViewSelfSchema>;

/** Admin profile — includes moderation and relationship data. */
export const ProfileViewAdminSchema = ProfileViewSelfSchema.extend({
    blockedUsers: z.array(z.string()).optional(),
    followers: z.array(z.string()).optional(),
    following: z.array(z.string()).optional(),
    reportCount: z.number().optional(),
    isBanned: z.boolean().optional(),
});
export type ProfileViewAdmin = z.infer<typeof ProfileViewAdminSchema>;

/**
 * @deprecated Use the scoped view that matches your access level:
 * - ProfileViewBasicSchema (public)
 * - ProfileViewDetailedSchema (authenticated)
 * - ProfileViewSelfSchema (own profile / GET /users/me)
 * - ProfileViewAdminSchema (admin routes)
 */
export const ProfileViewSchema = ProfileViewAdminSchema;
export type ProfileView = z.infer<typeof ProfileViewSchema>;
