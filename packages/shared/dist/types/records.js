"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrganizationMemberRecordSchema = exports.OrganizationRecordSchema = exports.SipEnrichmentSchema = exports.BetaSignupRecordSchema = exports.ReplyRecordSchema = exports.PromptRecordSchema = exports.UserRecordSchema = exports.FirestoreTimestampSchema = void 0;
const zod_1 = require("zod");
const blob_1 = require("./blob");
// #region Core Schemas
// =================================================================================================
/**
 * Firestore Timestamp schema (strict)
 */
exports.FirestoreTimestampSchema = zod_1.z.union([
    zod_1.z.custom((data) => {
        return (data &&
            typeof data === 'object' &&
            (typeof data.toDate === 'function' || ('seconds' in data && 'nanoseconds' in data)));
    }),
    zod_1.z.string(),
    zod_1.z.number(),
    zod_1.z.date()
]).transform((data) => {
    if (data instanceof Date)
        return data;
    if (typeof data === 'string')
        return new Date(data);
    if (typeof data === 'number')
        return new Date(data);
    if (typeof data.toDate === 'function') {
        return data.toDate();
    }
    const timestamp = data;
    return new Date(timestamp.seconds * 1000 + timestamp.nanoseconds / 1000000);
});
// #endregion
// #region Records (Database Schemas)
// =================================================================================================
/**
 * The raw user data stored in Firestore.
 */
exports.UserRecordSchema = zod_1.z.object({
    /** Unique Firebase UID */
    id: zod_1.z.string(),
    /** Public handle (e.g. @brad). Optional for Lite Users. */
    handle: zod_1.z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/).nullable().optional(),
    /**
     * URL to RSS feed.
     * @note RSS Summary data is stored in sub-collection `enrichment/rss`.
     */
    rssFeedUrl: zod_1.z.string().nullable().optional(),
    /** User stated intent (e.g. "Podcaster", "Listener") */
    usageIntent: zod_1.z.string().nullable().optional(),
    /**
     * Domain for federated handle support.
     * Defaults to 'voxpop.com'.
     */
    domain: zod_1.z.string().default('voxpop.com'),
    /** Display Name (e.g. "Brad Thorson") */
    displayName: zod_1.z.string().max(50).optional(),
    /** Short bio/description */
    bio: zod_1.z.string().max(160).optional(),
    /** URL to avatar image */
    avatarUrl: zod_1.z.string().url().optional(),
    /** Server timestamp of creation */
    createdAt: exports.FirestoreTimestampSchema,
});
/**
 * The raw prompt data stored in Firestore.
 */
exports.PromptRecordSchema = zod_1.z.object({
    /** Unique Prompt ID */
    id: zod_1.z.string(),
    /** ID of the User who created this prompt. @see UserRecord */
    authorId: zod_1.z.string(),
    /** The main text of the question/prompt */
    title: zod_1.z.string().min(3),
    /** Optional extra context */
    description: zod_1.z.string().nullable().optional(),
    /** URL to the recorded audio file (GCS) */
    audioUrl: zod_1.z.string().url().or(zod_1.z.literal('')),
    /** AT Protocol blob reference (future replacement for audioUrl) */
    audio: blob_1.BlobRefSchema.optional(),
    /** Server timestamp of creation */
    createdAt: exports.FirestoreTimestampSchema,
    /**
     * Life-cycle status.
     * - `live`: Visible and accepting replies.
     * - `archived`: Visible but closed for new replies.
     * - `deleted`: Soft deleted.
     */
    status: zod_1.z.enum(['live', 'archived', 'deleted']).default('live'),
    /** AI Enrichment Fields */
    aiStatus: zod_1.z.enum(['pending', 'complete', 'error']).optional(),
    aiError: zod_1.z.string().optional(),
    aiSummary: zod_1.z.string().optional(),
    aiLabels: zod_1.z.array(zod_1.z.string()).optional(),
    transcription: zod_1.z.string().optional(),
});
/**
 * The raw reply data stored in Firestore.
 */
exports.ReplyRecordSchema = zod_1.z.object({
    /** Unique Reply ID */
    id: zod_1.z.string(),
    /** The Prompt being replied to. @see PromptRecord */
    promptId: zod_1.z.string(),
    /** The User who replied. @see UserRecord */
    authorId: zod_1.z.string(),
    /** URL to the recorded audio file (GCS) */
    audioUrl: zod_1.z.string().url(),
    /** AT Protocol blob reference (future replacement for audioUrl) */
    audio: blob_1.BlobRefSchema.optional(),
    /** Server timestamp of creation */
    createdAt: exports.FirestoreTimestampSchema,
    /** Life-cycle status */
    status: zod_1.z.enum(['live', 'archived']).default('live'),
    /** @deprecated AT Protocol migration field (Optional) */
    replyToUri: zod_1.z.string().optional(),
    /** Private notes by the Prompt author about this reply */
    notes: zod_1.z.string().optional(),
    /** AI Enrichment Fields */
    aiStatus: zod_1.z.enum(['pending', 'complete', 'error']).optional(),
    aiError: zod_1.z.string().optional(),
    aiSummary: zod_1.z.string().optional(),
    aiLabels: zod_1.z.array(zod_1.z.string()).optional(),
    transcription: zod_1.z.string().optional(),
    sentiment: zod_1.z.enum(['Positive', 'Negative', 'Neutral']).optional(),
    energyLevel: zod_1.z.enum(['High', 'Low']).optional(),
    engagementScore: zod_1.z.number().min(1).max(10).optional(),
});
/**
 * The raw beta signup data stored in Firestore.
 */
exports.BetaSignupRecordSchema = zod_1.z.object({
    /** Unique Signup ID (usually auto-generated or email-based) */
    id: zod_1.z.string(),
    /** User's email address */
    email: zod_1.z.string().email(),
    /** Stated intent for using Vox Pop */
    usageIntent: zod_1.z.string().min(3),
    /** Optional invite code used during signup */
    inviteCode: zod_1.z.string().optional(),
    /** Server timestamp of signup */
    createdAt: exports.FirestoreTimestampSchema,
    /** Current status of the signup (waitlist, invited, joined) */
    status: zod_1.z.enum(['waitlist', 'invited', 'joined']).default('waitlist'),
    /** The invite code generated for this user (when invited) */
    generatedInviteCode: zod_1.z.string().optional(),
    /** Timestamp when the user was invited */
    invitedAt: exports.FirestoreTimestampSchema.optional(),
});
/**
 * SIP Enrichment data stored in `users/{uid}/enrichment/sip`.
 */
exports.SipEnrichmentSchema = zod_1.z.object({
    sipUri: zod_1.z.string(),
    sipUsername: zod_1.z.string(),
    sipSecret: zod_1.z.string(),
    provider: zod_1.z.enum(['twilio', 'plivo', 'internal']),
});
// #endregion
// #region Organization Schemas
// =================================================================================================
/**
 * An Organization (Workspace) that users can be members of.
 */
exports.OrganizationRecordSchema = zod_1.z.object({
    id: zod_1.z.string(),
    /** Display name of the organization */
    name: zod_1.z.string().min(3).max(50),
    /** URL to avatar/logo */
    avatarUrl: zod_1.z.string().url().optional(),
    /** Owner ID (User ID) */
    ownerId: zod_1.z.string(),
    /** Server timestamp of creation */
    createdAt: exports.FirestoreTimestampSchema,
    /** Stripe Customer ID */
    stripeCustomerId: zod_1.z.string().optional(),
    /** Subscription Status */
    subscriptionStatus: zod_1.z.enum(['active', 'trialing', 'past_due', 'canceled', 'unpaid']).optional(),
});
/**
 * A member of an Organization.
 * Stored in `organizations/{orgId}/members/{userId}`
 */
exports.OrganizationMemberRecordSchema = zod_1.z.object({
    id: zod_1.z.string(), // userId
    orgId: zod_1.z.string(),
    userId: zod_1.z.string(),
    /** Role in the organization */
    role: zod_1.z.enum(['owner', 'admin', 'member']),
    /** Server timestamp of joining */
    joinedAt: exports.FirestoreTimestampSchema,
    invitedBy: zod_1.z.string().optional(),
});
// #endregion
