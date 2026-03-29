import { z } from 'zod';
import { BlobRefSchema } from './blob';

// #region Core Schemas
// =================================================================================================

/**
 * Firestore Timestamp schema (strict)
 */
export const FirestoreTimestampSchema = z.union([
    z.custom<unknown>((data: unknown) => {
        return (
            data &&
            typeof data === 'object' &&
            (typeof (data as { toDate?: unknown }).toDate === 'function' || ('seconds' in data && 'nanoseconds' in data))
        );
    }),
    z.string(),
    z.number(),
    z.date()
]).transform((data: unknown) => {
    if (data instanceof Date) return data;
    if (typeof data === 'string') return new Date(data);
    if (typeof data === 'number') return new Date(data);
    if (typeof (data as { toDate?: () => Date }).toDate === 'function') {
        return (data as { toDate: () => Date }).toDate();
    }
    const timestamp = data as { seconds: number; nanoseconds: number };
    return new Date(timestamp.seconds * 1000 + timestamp.nanoseconds / 1000000);
});
export type FirestoreTimestamp = Date;

// #endregion

// #region Records (Database Schemas)
// =================================================================================================

/**
 * The raw user data stored in Firestore.
 */
export const UserRecordSchema = z.object({
    /** Unique Firebase UID */
    id: z.string(),
    /** Public handle (e.g. @brad). Optional for Lite Users. */
    handle: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/).nullable().optional(),

    /** User stated intent (e.g. "Podcaster", "Listener") */
    usageIntent: z.string().nullable().optional(),
    /** 
     * Domain for federated handle support. 
     * Defaults to 'voxpop.com'.
     */
    domain: z.string().default('voxpop.com'),
    /** Display Name (e.g. "Brad Thorson") */
    displayName: z.string().max(50).optional(),
    /** Short bio/description */
    bio: z.string().max(160).optional(),
    /** URL to avatar image */
    avatarUrl: z.string().url().optional(),
    /** Server timestamp of creation */
    createdAt: FirestoreTimestampSchema,
    /**
     * Denormalized org memberships — { orgId: role } for fast lookup.
     * Source of truth is organizations/{orgId}/members/{userId}.
     * Kept in sync by Cloud Function trigger.
     */
    orgMemberships: z.record(z.string(), z.enum(['owner', 'admin', 'member'])).optional(),
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

/**
 * The raw prompt data stored in Firestore.
 */
export const PromptRecordSchema = z.object({
    /** Unique Prompt ID */
    id: z.string(),
    /** ID of the User who created this prompt. @see UserRecord */
    authorId: z.string(),
    /** The main text of the question/prompt */
    title: z.string().min(3),
    /** Optional extra context */
    description: z.string().nullable().optional(),
    /** User who created this prompt (differs from authorId when org-owned) */
    createdBy: z.string().optional(),
    /** URL to the recorded audio file (GCS) */
    audioUrl: z.string().url().or(z.literal('')),
    /** AT Protocol blob reference (future replacement for audioUrl) */
    audio: BlobRefSchema.optional(),
    /** Server timestamp of creation */
    createdAt: FirestoreTimestampSchema,
    /**
     * Life-cycle status.
     * - `live`: Visible and accepting replies.
     * - `archived`: Visible but closed for new replies.
     * - `deleted`: Soft deleted.
     */
    status: z.enum(['live', 'archived', 'deleted']).default('live'),
    /** AI Enrichment Fields */
    aiStatus: z.enum(['pending', 'complete', 'error']).optional(),
    aiError: z.string().optional(),
    aiSummary: z.string().optional(),
    aiLabels: z.array(z.string()).optional(),
    transcription: z.string().optional(),
    /** Pre-computed waveform peaks (normalized 0–1) for instant audio visualization */
    waveformPeaks: z.array(z.number()).optional(),
    /** Social Share Video Fields */
    socialVideoUrl: z.string().url().optional(),
    socialVideoStoragePath: z.string().optional(),
    socialVideoStatus: z.enum(['pending', 'complete', 'error']).optional(),
    socialVideoError: z.string().optional(),
    /** The audio URL/path used to generate the current video (for cache invalidation) */
    socialVideoSourceAudio: z.string().optional(),
});
export type PromptRecord = z.infer<typeof PromptRecordSchema>;

/**
 * The raw reply data stored in Firestore.
 */
export const ReplyRecordSchema = z.object({
    /** Unique Reply ID */
    id: z.string(),
    /** The Prompt being replied to. @see PromptRecord */
    promptId: z.string(),
    /** The User who replied. @see UserRecord */
    authorId: z.string(),
    /** URL to the recorded audio file (GCS) */
    audioUrl: z.string().url(),
    /** AT Protocol blob reference (future replacement for audioUrl) */
    audio: BlobRefSchema.optional(),
    /** Server timestamp of creation */
    createdAt: FirestoreTimestampSchema,
    /**
     * Life-cycle status.
     * - `live`: Visible and accepting replies.
     * - `archived`: Visible but closed for new replies.
     * - `deleted`: Soft deleted.
     */
    status: z.enum(['live', 'archived', 'deleted']).default('live'),
    /** @deprecated AT Protocol migration field (Optional) */
    replyToUri: z.string().optional(),
    /** Private notes by the Prompt author about this reply */
    notes: z.string().optional(),
    /** AI Enrichment Fields */
    aiStatus: z.enum(['pending', 'complete', 'error']).optional(),
    aiError: z.string().optional(),
    aiSummary: z.string().optional(),
    aiLabels: z.array(z.string()).optional(),
    transcription: z.string().optional(),
    sentiment: z.enum(['Positive', 'Negative', 'Neutral']).optional(),
    energyLevel: z.enum(['High', 'Low']).optional(),
    engagementScore: z.number().min(1).max(10).optional(),
    /** Pre-computed waveform peaks (normalized 0–1) for instant audio visualization */
    waveformPeaks: z.array(z.number()).optional(),
    /** Social Share Video Fields */
    socialVideoUrl: z.string().url().optional(),
    socialVideoStoragePath: z.string().optional(),
    socialVideoStatus: z.enum(['pending', 'complete', 'error']).optional(),
    socialVideoError: z.string().optional(),
    /** The audio URL/path used to generate the current video (for cache invalidation) */
    socialVideoSourceAudio: z.string().optional(),
});
export type ReplyRecord = z.infer<typeof ReplyRecordSchema>;



/**
 * SIP Enrichment data stored in `users/{uid}/enrichment/sip`.
 */
export const SipEnrichmentSchema = z.object({
    sipUri: z.string(),
    sipUsername: z.string(),
    sipSecret: z.string(),
    provider: z.enum(['twilio', 'plivo', 'internal']),
});
export type SipEnrichment = z.infer<typeof SipEnrichmentSchema>;

// #endregion

// #region Organization Schemas
// =================================================================================================

/**
 * An Organization (Workspace) that users can be members of.
 */
export const OrganizationRecordSchema = z.object({
    id: z.string(),
    /** Display name of the organization */
    name: z.string().min(3).max(50),
    /** 
     * Unique handle for the organization (e.g. voxpop.com/@mypodcast).
     * Used for public URLs.
     */
    slug: z.string().min(3).max(30).regex(/^[a-z0-9-]+$/),
    /** URL to avatar/logo */
    avatarUrl: z.string().url().optional(),
    /** URL to the podcast RSS feed */
    rssFeedUrl: z.string().url().optional(),
    /** External website URL */
    websiteUrl: z.string().url().optional(),
    /** Description or tagline */
    description: z.string().optional(),
    /** Owner ID (User ID) */
    ownerId: z.string(),
    /** Server timestamp of creation */
    createdAt: FirestoreTimestampSchema,
    /** Verified domain (e.g., "acme.com") — enables auto-join, enterprise features */
    domain: z.string().nullable().optional(),
    /** Whether the domain has been verified via DNS TXT record */
    domainVerified: z.boolean().default(false),
    /** DNS verification token (stored server-side until verification completes) */
    domainVerificationToken: z.string().optional(),
    /** Billing email — required for paid orgs, where invoices go */
    billingEmail: z.string().email().nullable().optional(),
    /** Tier determines isolation and feature set */
    tier: z.enum(['free', 'pro', 'enterprise']).default('free'),
    /** Stripe Customer ID */
    stripeCustomerId: z.string().optional(),
    /** Subscription Status */
    subscriptionStatus: z.enum(['active', 'trialing', 'past_due', 'canceled', 'unpaid']).optional(),
});
export type OrganizationRecord = z.infer<typeof OrganizationRecordSchema>;

/**
 * A member of an Organization.
 * Stored in `organizations/{orgId}/members/{userId}`
 */
export const OrganizationMemberRecordSchema = z.object({
    orgId: z.string(),
    userId: z.string(),
    /** Role in the organization */
    role: z.enum(['owner', 'admin', 'member']),
    /** Server timestamp of joining */
    joinedAt: FirestoreTimestampSchema,
    invitedBy: z.string().optional(),
});
export type OrganizationMemberRecord = z.infer<typeof OrganizationMemberRecordSchema>;

/**
 * An invite to join an Organization.
 * Stored in `organizations/{orgId}/invites/{inviteId}`
 */
export const OrgInviteRecordSchema = z.object({
    id: z.string(),
    orgId: z.string(),
    /** Email the invite was sent to */
    email: z.string().email(),
    /** Role to assign on acceptance */
    role: z.enum(['admin', 'member']),
    /** User ID of who sent the invite */
    invitedBy: z.string(),
    /** Invite lifecycle status */
    status: z.enum(['pending', 'accepted', 'expired', 'revoked']).default('pending'),
    /** Server timestamp of creation */
    createdAt: FirestoreTimestampSchema,
    /** When this invite expires */
    expiresAt: FirestoreTimestampSchema,
});
export type OrgInviteRecord = z.infer<typeof OrgInviteRecordSchema>;

// #endregion
