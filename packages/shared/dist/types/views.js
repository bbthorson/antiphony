"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptRepliersSchema = exports.OrganizationViewSchema = exports.BetaSignupViewSchema = exports.ReplyViewSchema = exports.PromptViewSchema = exports.ProfileViewSchema = exports.ProfileViewAdminSchema = exports.ProfileViewSelfSchema = exports.ProfileViewDetailedSchema = exports.ProfileViewBasicSchema = void 0;
const zod_1 = require("zod");
const records_1 = require("./records");
/**
 * Layered Profile Views
 * Each level extends the previous, adding more fields.
 * This ensures sensitive data is only included when appropriate.
 */
/** Public profile — safe to return to any caller. */
exports.ProfileViewBasicSchema = zod_1.z.object({
    id: zod_1.z.string(),
    handle: zod_1.z.string().nullable().optional(),
    displayName: zod_1.z.string().optional(),
    avatarUrl: zod_1.z.string().nullable().optional(),
    bio: zod_1.z.string().optional(),
    stats: zod_1.z.object({
        followers: zod_1.z.number().default(0),
        following: zod_1.z.number().default(0),
        prompts: zod_1.z.number().default(0),
    }).optional(),
    badges: zod_1.z.array(zod_1.z.string()).optional(),
    isVerified: zod_1.z.boolean().optional(),
    createdAt: records_1.FirestoreTimestampSchema.optional(),
});
/** Authenticated viewer — includes enrichment data visible to other users. */
exports.ProfileViewDetailedSchema = exports.ProfileViewBasicSchema.extend({
    /** AT Protocol Identity link */
    bluesky: zod_1.z.object({
        handle: zod_1.z.string(),
        did: zod_1.z.string(),
    }).optional(),
    rssFeedUrl: zod_1.z.string().optional().nullable(),
    usageIntent: zod_1.z.string().optional().nullable(),
    /** Hydrated RSS Data (fetched from sub-collection) */
    rssSummary: zod_1.z.object({
        title: zod_1.z.string().optional(),
        description: zod_1.z.string().optional(),
        items: zod_1.z.array(zod_1.z.object({
            title: zod_1.z.string().optional(),
            link: zod_1.z.string().optional(),
            content: zod_1.z.string().optional(),
            pubDate: zod_1.z.string().optional(),
        })).optional(),
        lastFetchedAt: records_1.FirestoreTimestampSchema.optional(),
    }).optional(),
    promptAudioUrl: zod_1.z.string().optional(),
    totalPrompts: zod_1.z.number().optional(),
    totalReplies: zod_1.z.number().optional(),
    favoritePromptId: zod_1.z.string().optional(),
});
/** Own profile — includes private settings and activity data. */
exports.ProfileViewSelfSchema = exports.ProfileViewDetailedSchema.extend({
    phoneNumber: zod_1.z.string().nullable().optional(),
    email: zod_1.z.string().optional(),
    lastSeenAt: records_1.FirestoreTimestampSchema.optional(),
    lastActiveAt: records_1.FirestoreTimestampSchema.optional(),
    unreadReplyCount: zod_1.z.number().default(0),
    newReplierCount: zod_1.z.number().default(0),
    settings: zod_1.z.object({
        notifications: zod_1.z.boolean().optional(),
        theme: zod_1.z.string().optional(),
    }).optional(),
});
/** Admin profile — includes moderation and relationship data. */
exports.ProfileViewAdminSchema = exports.ProfileViewSelfSchema.extend({
    blockedUsers: zod_1.z.array(zod_1.z.string()).optional(),
    followers: zod_1.z.array(zod_1.z.string()).optional(),
    following: zod_1.z.array(zod_1.z.string()).optional(),
    reportCount: zod_1.z.number().optional(),
    isBanned: zod_1.z.boolean().optional(),
});
/**
 * @deprecated Use the scoped view that matches your access level:
 * - ProfileViewBasicSchema (public)
 * - ProfileViewDetailedSchema (authenticated)
 * - ProfileViewSelfSchema (own profile / GET /users/me)
 * - ProfileViewAdminSchema (admin routes)
 */
exports.ProfileViewSchema = exports.ProfileViewAdminSchema;
/**
 * A hydrated view of a prompt, including the author's profile.
 */
exports.PromptViewSchema = zod_1.z.object({
    /** AT Protocol URI (e.g. at://did:plc.../app.../123) */
    uri: zod_1.z.string().optional(),
    /** IPFS Content ID */
    cid: zod_1.z.string().optional(),
    /** The raw prompt data */
    record: records_1.PromptRecordSchema,
    /** The hydrated author profile */
    author: exports.ProfileViewSchema,
    /** Total number of replies */
    replyCount: zod_1.z.number().default(0),
    likeCount: zod_1.z.number().default(0),
    updatedAt: records_1.FirestoreTimestampSchema.optional(),
    lastReplyAt: records_1.FirestoreTimestampSchema.optional(),
    tags: zod_1.z.array(zod_1.z.string()).optional(),
    visibility: zod_1.z.enum(["public", "private", "unlisted", "archived"]).default("public"),
    analytics: zod_1.z.object({
        views: zod_1.z.number().default(0),
        listens: zod_1.z.number().default(0),
    }).optional(),
    moderation: zod_1.z.object({
        flagged: zod_1.z.boolean().default(false),
        reason: zod_1.z.string().optional(),
    }).optional(),
    // AI Enrichment Fields (Hydrated from Record but hidden from Record Schema)
    aiScore: zod_1.z.number().optional(),
    aiLabels: zod_1.z.array(zod_1.z.string()).optional(),
    aiSummary: zod_1.z.string().optional(),
    aiStatus: zod_1.z.enum(['pending', 'complete', 'error']).optional(),
    aiError: zod_1.z.string().optional(),
    transcription: zod_1.z.string().optional(),
});
/**
 * A hydrated view of a reply, including author and recipient profiles.
 */
exports.ReplyViewSchema = zod_1.z.object({
    record: records_1.ReplyRecordSchema,
    author: exports.ProfileViewSchema,
    recipient: exports.ProfileViewSchema,
    /** GCS Storage Path for audio file */
    storagePath: zod_1.z.string().optional(),
    duration: zod_1.z.number().optional(),
    updatedAt: records_1.FirestoreTimestampSchema.optional(),
    isRead: zod_1.z.boolean(),
    readBy: zod_1.z.array(zod_1.z.string()).default([]),
    isDeleted: zod_1.z.boolean().default(false),
    reactions: zod_1.z.record(zod_1.z.string(), zod_1.z.number()).optional(),
    moderation: zod_1.z.object({
        flagged: zod_1.z.boolean().default(false),
        reason: zod_1.z.string().optional(),
    }).optional(),
    // AI Enrichment Fields (Hydrated from Record but hidden from Record Schema)
    aiScore: zod_1.z.number().optional(),
    aiLabels: zod_1.z.array(zod_1.z.string()).optional(),
    aiSummary: zod_1.z.string().optional(),
    aiStatus: zod_1.z.enum(['pending', 'complete', 'error']).optional(),
    aiError: zod_1.z.string().optional(),
    transcription: zod_1.z.string().optional(),
    sentiment: zod_1.z.enum(['Positive', 'Negative', 'Neutral']).optional(),
    energyLevel: zod_1.z.enum(['High', 'Low']).optional(),
    engagementScore: zod_1.z.number().min(1).max(10).optional(),
    /** @private Confirmed listener phone number (never exposed publicly) */
    listenerPhoneNumber: zod_1.z.string().regex(/^\+[1-9]\d{1,14}$/).optional(),
    isVerified: zod_1.z.boolean().default(false),
    authorRating: zod_1.z.number().optional(),
    authorTags: zod_1.z.array(zod_1.z.string()).optional(),
    authorNotes: zod_1.z.string().optional(),
});
/**
 * A view of a beta signup.
 */
exports.BetaSignupViewSchema = zod_1.z.object({
    record: records_1.BetaSignupRecordSchema,
});
// #endregion
// #region Organization Views
// =================================================================================================
exports.OrganizationViewSchema = zod_1.z.object({
    record: records_1.OrganizationRecordSchema,
    memberCount: zod_1.z.number().default(1),
    currentUserRole: zod_1.z.enum(['owner', 'admin', 'member']).optional(),
});
exports.PromptRepliersSchema = zod_1.z.object({
    promptId: zod_1.z.string(),
    repliers: zod_1.z.record(zod_1.z.string(), zod_1.z.object({
        firstReplyAt: records_1.FirestoreTimestampSchema,
        lastReplyAt: records_1.FirestoreTimestampSchema,
        replyCount: zod_1.z.number(),
    })),
});
// #endregion
