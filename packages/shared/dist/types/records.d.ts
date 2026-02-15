import { z } from 'zod';
/**
 * Firestore Timestamp schema (strict)
 */
export declare const FirestoreTimestampSchema: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
export type FirestoreTimestamp = Date;
/**
 * The raw user data stored in Firestore.
 */
export declare const UserRecordSchema: z.ZodObject<{
    /** Unique Firebase UID */
    id: z.ZodString;
    /** Public handle (e.g. @brad). Optional for Lite Users. */
    handle: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    /**
     * URL to RSS feed.
     * @note RSS Summary data is stored in sub-collection `enrichment/rss`.
     */
    rssFeedUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    /** User stated intent (e.g. "Podcaster", "Listener") */
    usageIntent: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    /**
     * Domain for federated handle support.
     * Defaults to 'voxpop.com'.
     */
    domain: z.ZodDefault<z.ZodString>;
    /** Display Name (e.g. "Brad Thorson") */
    displayName: z.ZodOptional<z.ZodString>;
    /** Short bio/description */
    bio: z.ZodOptional<z.ZodString>;
    /** URL to avatar image */
    avatarUrl: z.ZodOptional<z.ZodString>;
    /** Server timestamp of creation */
    createdAt: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
}, "strip", z.ZodTypeAny, {
    id: string;
    domain: string;
    createdAt: Date;
    handle?: string | null | undefined;
    displayName?: string | undefined;
    bio?: string | undefined;
    avatarUrl?: string | undefined;
    rssFeedUrl?: string | null | undefined;
    usageIntent?: string | null | undefined;
}, {
    id: string;
    handle?: string | null | undefined;
    displayName?: string | undefined;
    bio?: string | undefined;
    avatarUrl?: string | undefined;
    rssFeedUrl?: string | null | undefined;
    usageIntent?: string | null | undefined;
    domain?: string | undefined;
    createdAt?: unknown;
}>;
export type UserRecord = z.infer<typeof UserRecordSchema>;
/**
 * The raw prompt data stored in Firestore.
 */
export declare const PromptRecordSchema: z.ZodObject<{
    /** Unique Prompt ID */
    id: z.ZodString;
    /** ID of the User who created this prompt. @see UserRecord */
    authorId: z.ZodString;
    /** The main text of the question/prompt */
    title: z.ZodString;
    /** Optional extra context */
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    /** URL to the recorded audio file (GCS) */
    audioUrl: z.ZodUnion<[z.ZodString, z.ZodLiteral<"">]>;
    /** AT Protocol blob reference (future replacement for audioUrl) */
    audio: z.ZodOptional<z.ZodObject<{
        $type: z.ZodLiteral<"blob">;
        ref: z.ZodString;
        mimeType: z.ZodString;
        size: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        $type: "blob";
        ref: string;
        mimeType: string;
        size: number;
    }, {
        $type: "blob";
        ref: string;
        mimeType: string;
        size: number;
    }>>;
    /** Server timestamp of creation */
    createdAt: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
    /**
     * Life-cycle status.
     * - `live`: Visible and accepting replies.
     * - `archived`: Visible but closed for new replies.
     * - `deleted`: Soft deleted.
     */
    status: z.ZodDefault<z.ZodEnum<["live", "archived", "deleted"]>>;
    /** AI Enrichment Fields */
    aiStatus: z.ZodOptional<z.ZodEnum<["pending", "complete", "error"]>>;
    aiError: z.ZodOptional<z.ZodString>;
    aiSummary: z.ZodOptional<z.ZodString>;
    aiLabels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    transcription: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "live" | "archived" | "deleted";
    audioUrl: string;
    title: string;
    id: string;
    createdAt: Date;
    authorId: string;
    description?: string | null | undefined;
    audio?: {
        $type: "blob";
        ref: string;
        mimeType: string;
        size: number;
    } | undefined;
    aiStatus?: "pending" | "complete" | "error" | undefined;
    aiError?: string | undefined;
    aiSummary?: string | undefined;
    aiLabels?: string[] | undefined;
    transcription?: string | undefined;
}, {
    audioUrl: string;
    title: string;
    id: string;
    authorId: string;
    status?: "live" | "archived" | "deleted" | undefined;
    description?: string | null | undefined;
    createdAt?: unknown;
    audio?: {
        $type: "blob";
        ref: string;
        mimeType: string;
        size: number;
    } | undefined;
    aiStatus?: "pending" | "complete" | "error" | undefined;
    aiError?: string | undefined;
    aiSummary?: string | undefined;
    aiLabels?: string[] | undefined;
    transcription?: string | undefined;
}>;
export type PromptRecord = z.infer<typeof PromptRecordSchema>;
/**
 * The raw reply data stored in Firestore.
 */
export declare const ReplyRecordSchema: z.ZodObject<{
    /** Unique Reply ID */
    id: z.ZodString;
    /** The Prompt being replied to. @see PromptRecord */
    promptId: z.ZodString;
    /** The User who replied. @see UserRecord */
    authorId: z.ZodString;
    /** URL to the recorded audio file (GCS) */
    audioUrl: z.ZodString;
    /** AT Protocol blob reference (future replacement for audioUrl) */
    audio: z.ZodOptional<z.ZodObject<{
        $type: z.ZodLiteral<"blob">;
        ref: z.ZodString;
        mimeType: z.ZodString;
        size: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        $type: "blob";
        ref: string;
        mimeType: string;
        size: number;
    }, {
        $type: "blob";
        ref: string;
        mimeType: string;
        size: number;
    }>>;
    /** Server timestamp of creation */
    createdAt: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
    /** Life-cycle status */
    status: z.ZodDefault<z.ZodEnum<["live", "archived"]>>;
    /** @deprecated AT Protocol migration field (Optional) */
    replyToUri: z.ZodOptional<z.ZodString>;
    /** Private notes by the Prompt author about this reply */
    notes: z.ZodOptional<z.ZodString>;
    /** AI Enrichment Fields */
    aiStatus: z.ZodOptional<z.ZodEnum<["pending", "complete", "error"]>>;
    aiError: z.ZodOptional<z.ZodString>;
    aiSummary: z.ZodOptional<z.ZodString>;
    aiLabels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    transcription: z.ZodOptional<z.ZodString>;
    sentiment: z.ZodOptional<z.ZodEnum<["Positive", "Negative", "Neutral"]>>;
    energyLevel: z.ZodOptional<z.ZodEnum<["High", "Low"]>>;
    engagementScore: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    status: "live" | "archived";
    audioUrl: string;
    promptId: string;
    id: string;
    createdAt: Date;
    authorId: string;
    audio?: {
        $type: "blob";
        ref: string;
        mimeType: string;
        size: number;
    } | undefined;
    aiStatus?: "pending" | "complete" | "error" | undefined;
    aiError?: string | undefined;
    aiSummary?: string | undefined;
    aiLabels?: string[] | undefined;
    transcription?: string | undefined;
    replyToUri?: string | undefined;
    notes?: string | undefined;
    sentiment?: "Positive" | "Negative" | "Neutral" | undefined;
    energyLevel?: "High" | "Low" | undefined;
    engagementScore?: number | undefined;
}, {
    audioUrl: string;
    promptId: string;
    id: string;
    authorId: string;
    status?: "live" | "archived" | undefined;
    createdAt?: unknown;
    audio?: {
        $type: "blob";
        ref: string;
        mimeType: string;
        size: number;
    } | undefined;
    aiStatus?: "pending" | "complete" | "error" | undefined;
    aiError?: string | undefined;
    aiSummary?: string | undefined;
    aiLabels?: string[] | undefined;
    transcription?: string | undefined;
    replyToUri?: string | undefined;
    notes?: string | undefined;
    sentiment?: "Positive" | "Negative" | "Neutral" | undefined;
    energyLevel?: "High" | "Low" | undefined;
    engagementScore?: number | undefined;
}>;
export type ReplyRecord = z.infer<typeof ReplyRecordSchema>;
/**
 * The raw beta signup data stored in Firestore.
 */
export declare const BetaSignupRecordSchema: z.ZodObject<{
    /** Unique Signup ID (usually auto-generated or email-based) */
    id: z.ZodString;
    /** User's email address */
    email: z.ZodString;
    /** Stated intent for using Vox Pop */
    usageIntent: z.ZodString;
    /** Optional invite code used during signup */
    inviteCode: z.ZodOptional<z.ZodString>;
    /** Server timestamp of signup */
    createdAt: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
    /** Current status of the signup (waitlist, invited, joined) */
    status: z.ZodDefault<z.ZodEnum<["waitlist", "invited", "joined"]>>;
    /** The invite code generated for this user (when invited) */
    generatedInviteCode: z.ZodOptional<z.ZodString>;
    /** Timestamp when the user was invited */
    invitedAt: z.ZodOptional<z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>>;
}, "strip", z.ZodTypeAny, {
    status: "waitlist" | "invited" | "joined";
    usageIntent: string;
    email: string;
    id: string;
    createdAt: Date;
    inviteCode?: string | undefined;
    generatedInviteCode?: string | undefined;
    invitedAt?: Date | undefined;
}, {
    usageIntent: string;
    email: string;
    id: string;
    status?: "waitlist" | "invited" | "joined" | undefined;
    inviteCode?: string | undefined;
    createdAt?: unknown;
    generatedInviteCode?: string | undefined;
    invitedAt?: unknown;
}>;
export type BetaSignupRecord = z.infer<typeof BetaSignupRecordSchema>;
/**
 * SIP Enrichment data stored in `users/{uid}/enrichment/sip`.
 */
export declare const SipEnrichmentSchema: z.ZodObject<{
    sipUri: z.ZodString;
    sipUsername: z.ZodString;
    sipSecret: z.ZodString;
    provider: z.ZodEnum<["twilio", "plivo", "internal"]>;
}, "strip", z.ZodTypeAny, {
    sipUri: string;
    sipUsername: string;
    sipSecret: string;
    provider: "twilio" | "plivo" | "internal";
}, {
    sipUri: string;
    sipUsername: string;
    sipSecret: string;
    provider: "twilio" | "plivo" | "internal";
}>;
export type SipEnrichment = z.infer<typeof SipEnrichmentSchema>;
/**
 * An Organization (Workspace) that users can be members of.
 */
export declare const OrganizationRecordSchema: z.ZodObject<{
    id: z.ZodString;
    /** Display name of the organization */
    name: z.ZodString;
    /** URL to avatar/logo */
    avatarUrl: z.ZodOptional<z.ZodString>;
    /** Owner ID (User ID) */
    ownerId: z.ZodString;
    /** Server timestamp of creation */
    createdAt: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
    /** Stripe Customer ID */
    stripeCustomerId: z.ZodOptional<z.ZodString>;
    /** Subscription Status */
    subscriptionStatus: z.ZodOptional<z.ZodEnum<["active", "trialing", "past_due", "canceled", "unpaid"]>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    createdAt: Date;
    name: string;
    ownerId: string;
    avatarUrl?: string | undefined;
    stripeCustomerId?: string | undefined;
    subscriptionStatus?: "active" | "trialing" | "past_due" | "canceled" | "unpaid" | undefined;
}, {
    id: string;
    name: string;
    ownerId: string;
    avatarUrl?: string | undefined;
    createdAt?: unknown;
    stripeCustomerId?: string | undefined;
    subscriptionStatus?: "active" | "trialing" | "past_due" | "canceled" | "unpaid" | undefined;
}>;
export type OrganizationRecord = z.infer<typeof OrganizationRecordSchema>;
/**
 * A member of an Organization.
 * Stored in `organizations/{orgId}/members/{userId}`
 */
export declare const OrganizationMemberRecordSchema: z.ZodObject<{
    id: z.ZodString;
    orgId: z.ZodString;
    userId: z.ZodString;
    /** Role in the organization */
    role: z.ZodEnum<["owner", "admin", "member"]>;
    /** Server timestamp of joining */
    joinedAt: z.ZodEffects<z.ZodUnion<[z.ZodType<unknown, z.ZodTypeDef, unknown>, z.ZodString, z.ZodNumber, z.ZodDate]>, Date, unknown>;
    invitedBy: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    userId: string;
    id: string;
    orgId: string;
    role: "owner" | "admin" | "member";
    joinedAt: Date;
    invitedBy?: string | undefined;
}, {
    userId: string;
    id: string;
    orgId: string;
    role: "owner" | "admin" | "member";
    joinedAt?: unknown;
    invitedBy?: string | undefined;
}>;
export type OrganizationMemberRecord = z.infer<typeof OrganizationMemberRecordSchema>;
