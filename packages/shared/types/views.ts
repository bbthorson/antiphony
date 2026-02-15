import { z } from 'zod';
import { BetaSignupRecordSchema, FirestoreTimestampSchema, OrganizationRecordSchema, PromptRecordSchema, ReplyRecordSchema } from './records';

/**
 * Layered Profile Views
 * Each level extends the previous, adding more fields.
 * This ensures sensitive data is only included when appropriate.
 */

/** Public profile — safe to return to any caller. */
export const ProfileViewBasicSchema = z.object({
    id: z.string(),
    handle: z.string().nullable().optional(),
    displayName: z.string().optional(),
    avatarUrl: z.string().nullable().optional(),
    bio: z.string().optional(),
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

/** Authenticated viewer — includes enrichment data visible to other users. */
export const ProfileViewDetailedSchema = ProfileViewBasicSchema.extend({
    /** AT Protocol Identity link */
    bluesky: z.object({
        handle: z.string(),
        did: z.string(),
    }).optional(),
    rssFeedUrl: z.string().optional().nullable(),
    usageIntent: z.string().optional().nullable(),
    /** Hydrated RSS Data (fetched from sub-collection) */
    rssSummary: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        items: z.array(z.object({
            title: z.string().optional(),
            link: z.string().optional(),
            content: z.string().optional(),
            pubDate: z.string().optional(),
        })).optional(),
        lastFetchedAt: FirestoreTimestampSchema.optional(),
    }).optional(),
    promptAudioUrl: z.string().optional(),
    totalPrompts: z.number().optional(),
    totalReplies: z.number().optional(),
    favoritePromptId: z.string().optional(),
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

/**
 * A hydrated view of a prompt, including the author's profile.
 */
export const PromptViewSchema = z.object({
    /** AT Protocol URI (e.g. at://did:plc.../app.../123) */
    uri: z.string().optional(),
    /** IPFS Content ID */
    cid: z.string().optional(),
    /** The raw prompt data */
    record: PromptRecordSchema,
    /** The hydrated author profile */
    author: ProfileViewSchema,
    /** Total number of replies */
    replyCount: z.number().default(0),
    likeCount: z.number().default(0),
    updatedAt: FirestoreTimestampSchema.optional(),
    lastReplyAt: FirestoreTimestampSchema.optional(),
    tags: z.array(z.string()).optional(),
    visibility: z.enum(["public", "private", "unlisted", "archived"]).default("public"),
    analytics: z.object({
        views: z.number().default(0),
        listens: z.number().default(0),
    }).optional(),
    moderation: z.object({
        flagged: z.boolean().default(false),
        reason: z.string().optional(),
    }).optional(),
    // AI Enrichment Fields (Hydrated from Record but hidden from Record Schema)
    aiScore: z.number().optional(),
    aiLabels: z.array(z.string()).optional(),
    aiSummary: z.string().optional(),
    aiStatus: z.enum(['pending', 'complete', 'error']).optional(),
    aiError: z.string().optional(),
    transcription: z.string().optional(),
});
export type PromptView = z.infer<typeof PromptViewSchema>;


/**
 * A hydrated view of a reply, including author and recipient profiles.
 */
export const ReplyViewSchema = z.object({
    record: ReplyRecordSchema,
    author: ProfileViewSchema,
    recipient: ProfileViewSchema,
    /** GCS Storage Path for audio file */
    storagePath: z.string().optional(),
    duration: z.number().optional(),
    updatedAt: FirestoreTimestampSchema.optional(),
    isRead: z.boolean(),
    readBy: z.array(z.string()).default([]),
    isDeleted: z.boolean().default(false),
    reactions: z.record(z.string(), z.number()).optional(),
    moderation: z.object({
        flagged: z.boolean().default(false),
        reason: z.string().optional(),
    }).optional(),
    // AI Enrichment Fields (Hydrated from Record but hidden from Record Schema)
    aiScore: z.number().optional(),
    aiLabels: z.array(z.string()).optional(),
    aiSummary: z.string().optional(),
    aiStatus: z.enum(['pending', 'complete', 'error']).optional(),
    aiError: z.string().optional(),
    transcription: z.string().optional(),
    sentiment: z.enum(['Positive', 'Negative', 'Neutral']).optional(),
    energyLevel: z.enum(['High', 'Low']).optional(),
    engagementScore: z.number().min(1).max(10).optional(),
    /** @private Confirmed listener phone number (never exposed publicly) */
    listenerPhoneNumber: z.string().regex(/^\+[1-9]\d{1,14}$/).optional(),
    isVerified: z.boolean().default(false),
    authorRating: z.number().optional(),
    authorTags: z.array(z.string()).optional(),
    authorNotes: z.string().optional(),
});
export type ReplyView = z.infer<typeof ReplyViewSchema>;

/**
 * A view of a beta signup.
 */
export const BetaSignupViewSchema = z.object({
    record: BetaSignupRecordSchema,
});
export type BetaSignupView = z.infer<typeof BetaSignupViewSchema>;

// #endregion

// #region Organization Views
// =================================================================================================

export const OrganizationViewSchema = z.object({
    record: OrganizationRecordSchema,
    memberCount: z.number().default(1),
    currentUserRole: z.enum(['owner', 'admin', 'member']).optional(),
});
export type OrganizationView = z.infer<typeof OrganizationViewSchema>;

// #endregion

// #region DEPRECATED Schemas
// =================================================================================================
// These schemas are being replaced by the Record/View pattern.
// They are kept for backward compatibility during the migration.
// =================================================================================================






// #endregion

// #region Other Types
// =================================================================================================

export interface VoxPopEmbedWidgetProps {
    promptId?: string;
    targetUserId?: string;
    onRecordingStateChange?: (isRecording: boolean) => void;
    className?: string;
}

export const PromptRepliersSchema = z.object({
    promptId: z.string(),
    repliers: z.record(z.string(), z.object({
        firstReplyAt: FirestoreTimestampSchema,
        lastReplyAt: FirestoreTimestampSchema,
        replyCount: z.number(),
    })),
});
export type PromptRepliers = z.infer<typeof PromptRepliersSchema>;

export type PromptWithReplies = PromptView & { replies: ReplyView[] };

export interface Replier {
    handle: string;
    lastReplyDate: string; // ISO date string
    firstReplyAt: string; // ISO date string
    totalReplies: number;
}


// #endregion


