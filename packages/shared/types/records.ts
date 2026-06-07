import { z } from 'zod';
import { BlobRefSchema } from './blob';

// #region Core Schemas
// =================================================================================================

/**
 * Firestore Timestamp schema (strict).
 *
 * Accepts the shapes Firestore-derived timestamps come back as across our
 * transports (admin SDK Timestamp object, ISO string, epoch number, native
 * Date), and produces a `Date`. **The Date is validated** — if the input
 * coerces to an Invalid Date (e.g. `new Date("")` or a malformed string),
 * the parse fails loudly via a `ZodIssue` rather than returning a
 * downstream-crashing value.
 *
 * Why strict: PR #425 added defensive coercion in ReplyListItem after the
 * dashboard was crashing on `formatDistanceToNow(invalid)` calls. The
 * underlying issue was that `z.string()` here accepted any string and
 * `new Date(badString)` produces Invalid Date, which Zod returned
 * successfully. Rejecting at the schema boundary keeps downstream
 * `formatDistanceToNow` / `.toISOString()` callers safe by construction.
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
]).transform((data: unknown, ctx) => {
    let date: Date;
    if (data instanceof Date) {
        date = data;
    } else if (typeof data === 'string') {
        date = new Date(data);
    } else if (typeof data === 'number') {
        date = new Date(data);
    } else if (typeof (data as { toDate?: () => Date }).toDate === 'function') {
        date = (data as { toDate: () => Date }).toDate();
    } else {
        const timestamp = data as { seconds: number; nanoseconds: number };
        date = new Date(timestamp.seconds * 1000 + timestamp.nanoseconds / 1000000);
    }
    if (Number.isNaN(date.getTime())) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'FirestoreTimestamp coerced to Invalid Date',
        });
        return z.NEVER;
    }
    return date;
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
    /**
     * Display Name (e.g. "Brad Thorson"). Nullable: Firestore stores `null`
     * when the user clears this field via the settings form, and the schema
     * must match storage reality or `UserRecordSchema.parse` (in
     * `getUserRecordByUid`) will throw.
     */
    displayName: z.string().max(50).nullable().optional(),
    /** Short bio/description — nullable for the same reason as displayName. */
    bio: z.string().max(160).nullable().optional(),
    /** URL to avatar image — nullable for the same reason as displayName. */
    avatarUrl: z.string().url().nullable().optional(),
    /** Optional personal website surfaced on the public profile. */
    website: z.string().url().nullable().optional(),
    /** Up to 5 additional public links (label + URL) shown under the bio. */
    links: z.array(z.object({
        label: z.string().min(1).max(40),
        url: z.string().url(),
    })).max(5).optional(),
    /** When true and a Bluesky identity is linked, surfaces it on the public profile. */
    showBlueskyPublicly: z.boolean().optional(),
    /** Server timestamp of creation */
    createdAt: FirestoreTimestampSchema,
    /** Individual account tier — free or creator_pro */
    tier: z.enum(['free', 'creator_pro']).default('free'),
    /** Account status. Deactivated accounts retain data but are excluded from lookups. */
    status: z.enum(['active', 'deactivated']).default('active'),
    /** Timestamp when the account was deactivated (soft deleted) */
    deactivatedAt: FirestoreTimestampSchema.optional(),
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
    /** ID of the User who created this prompt. Always a user ID, never an org ID. @see UserRecord */
    authorId: z.string(),
    /** Organization context this prompt belongs to (null = personal/no org) */
    orgId: z.string().nullable().optional(),
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
    /**
     * AT Protocol URI returned by the publisher after a successful
     * `repo.putRecord` against the author's PDS — e.g.
     * `at://did:plc:abc123/com.voxpop.audio.prompt/3kj4...`. Optional,
     * no migration: existing rows leave it unset. Format-validated so
     * malformed strings surface at the schema-parse boundary rather than
     * being silently stored.
     */
    atprotoUri: z.string().regex(/^at:\/\/.+/).optional(),
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
 *
 * AI-derived fields (transcription, sentiment, engagement score, voice
 * isolation, social-share video, etc.) live on `ReplyEnrichmentRecord`
 * at `enrichments/replies/items/{id}` — see § 1 of
 * `specs/ai-enrichment-split.md`. Only ingestion-time outputs that a
 * self-hoster without paid AI still needs (waveform peaks + audio
 * duration) remain on the canonical doc.
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
    /**
     * Pre-computed waveform peaks (normalized 0–1) for instant audio
     * visualization. **Stays on canonical** (does NOT move to the
     * enrichment doc) — produced by a plain ffmpeg pass at ingestion,
     * not an AI step; a self-hoster without paid-tier AI still needs
     * this on every reply for the audio player. See
     * `specs/ai-enrichment-split.md` § 5.
     */
    waveformPeaks: z.array(z.number()).optional(),
    /**
     * Duration of the audio in seconds, computed server-side from
     * ffmpeg. **Stays on canonical** (same reasoning as `waveformPeaks`
     * above — ingestion ffmpeg output, not an AI enrichment). See
     * `specs/ai-enrichment-split.md` § 5.
     */
    audioDurationSec: z.number().optional(),
});
export type ReplyRecord = z.infer<typeof ReplyRecordSchema>;

/**
 * Reply Enrichment Record. Per-reply CRM data owned by the prompt-author
 * (the "viewer" with read/write access). Stored at
 * `enrichments/replies/{replyId}` — a separate namespace from the canonical
 * `replies/{replyId}` so self-hosters running just core-api see clean
 * records without phantom CRM fields. See specs/data-separation.md § 3.
 *
 * `id` matches the parent reply's id by convention (same doc id, sibling
 * collection space).
 */
export const ReplyEnrichmentRecordSchema = z.object({
    id: z.string(),
    /** Private notes by the prompt author about this reply. */
    notes: z.string().optional(),

    // === AI-enrichment fields (sole source of truth post Stage 4) ===
    //
    // These lifted off canonical in Stage 4 of `specs/ai-enrichment-split.md`.
    // Writers (`functions/`) route AI updates here via the split-write
    // helper in `functions/src/services/replyEnrichmentDualWrite.ts`;
    // readers source them via the hydrator's enrichment branch (see
    // `packages/core/services/hydration.ts`).

    // --- AI core (Gemini-generated) ---
    aiStatus: z.enum(['pending', 'complete', 'error', 'skipped_too_short']).optional(),
    aiError: z.string().optional(),
    aiSummary: z.string().optional(),
    aiLabels: z.array(z.string()).optional(),
    transcription: z.string().optional(),
    sentiment: z.enum(['Positive', 'Negative', 'Neutral']).optional(),
    /** Must match the widened enum in `ReplyRecordSchema.energyLevel`. */
    energyLevel: z.enum(['High', 'Low', 'Neutral']).optional(),
    engagementScore: z.number().min(1).max(10).optional(),

    // --- Voice isolation (ElevenLabs, paid tier) ---
    /** Noise-reduced audio URL — replaces `audioUrl` for downstream players when present. PUBLIC. */
    enhancedAudioUrl: z.string().url().optional(),
    /** Storage path companion to `enhancedAudioUrl` — private. */
    enhancedStoragePath: z.string().optional(),

    // --- Social-share video (paid tier) ---
    //
    // All `socialVideo*` fields are creator-only. The URL points at the
    // generated artifact (a video file the creator can download and post
    // to social media); the reply detail page does NOT render it.
    socialVideoUrl: z.string().url().optional(),
    socialVideoStoragePath: z.string().optional(),
    socialVideoStatus: z.enum(['pending', 'complete', 'error']).optional(),
    socialVideoError: z.string().optional(),
    /** The audio URL/path used to generate the current video (for cache invalidation). */
    socialVideoSourceAudio: z.string().optional(),
});
export type ReplyEnrichmentRecord = z.infer<typeof ReplyEnrichmentRecordSchema>;

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

/**
 * Call forwarding configuration stored in `users/{uid}/private_data/call_forwarding`.
 * Tracks the user's PSTN forwarding setup for routing missed calls to VoxPop IVR.
 */
export const CallForwardingConfigSchema = z.object({
    /** User's personal phone number (E.164) */
    phoneNumber: z.string(),
    /** Line type from Twilio Lookup v2 */
    lineType: z.string().nullable(),
    /** Carrier name from Twilio Lookup v2 */
    carrier: z.string().nullable(),
    /** free = shared Twilio number (ForwardedFrom routing), paid = dedicated number */
    tier: z.enum(['free', 'paid']),
    /** The VoxPop Twilio number calls forward to (E.164) */
    voxpopNumber: z.string(),
    /** Twilio Phone Number SID (paid tier only) */
    twilioNumberSid: z.string().nullable().optional(),
    /** Forwarding verification state */
    verificationStatus: z.enum(['pending', 'verifying', 'verified', 'failed']).default('pending'),
    /** Last verification attempt timestamp */
    lastVerificationAt: FirestoreTimestampSchema.optional(),
    /** Number of verification attempts */
    verificationAttempts: z.number().default(0),
    /** Reason for verification failure */
    failureReason: z.string().nullable().optional(),
    /** Whether call forwarding is active */
    enabled: z.boolean().default(false),
    createdAt: FirestoreTimestampSchema,
    updatedAt: FirestoreTimestampSchema,
});
export type CallForwardingConfig = z.infer<typeof CallForwardingConfigSchema>;

/**
 * A single screening (allowlist) rule — canonical user-authored config, NOT
 * derived/enriched, so it's owned by core-api (tier 1) like call-forwarding.
 * Stored per-user under `users/{uid}/private_data/screening/rules/{ruleId}`.
 *
 * "Who gets through": `allow` = ring through, `screen` = go async. A
 * time-boxed exception is just an `allow` rule with `expiresAt` set (enforced
 * at read/evaluation time — no scheduler). Under Phase-1 missed-call-only
 * capture these rules are foundational/editable but not yet gating ring-
 * through; they become behavioral at capture-all (Phase 2). See
 * `specs/consumer-call-app.md` § 5.
 */
export const ScreeningRuleRecordSchema = z.object({
    id: z.string(),
    ownerId: z.string(),
    /** The caller number this rule matches (E.164). Format-enforced at the
     *  record level so any writer (API, future contact-sync/callback) can't
     *  persist a malformed number. */
    e164: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Must be an E.164 phone number'),
    /** Display label, e.g. "Mom" / "Delta Airlines". null = unlabeled. */
    label: z.string().nullable().optional(),
    /** `allow` = ring through; `screen` = async voicemail. */
    action: z.enum(['allow', 'screen']),
    /** Provenance. `manual` = user-created; the others are future writers. */
    source: z.enum(['manual', 'contact-sync', 'callback']),
    /** null = permanent; a date = self-expiring exception. */
    expiresAt: FirestoreTimestampSchema.nullable().optional(),
    createdAt: FirestoreTimestampSchema,
});
export type ScreeningRuleRecord = z.infer<typeof ScreeningRuleRecordSchema>;

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
    /**
     * Tier determines isolation and feature set. Orgs are meant to be paid
     * (business or enterprise); free/pro exist on the enum for the individual track.
     * Default is provisionally `business` (the entry paid tier) — it's assigned at
     * creation with no subscription behind it yet, so it stays provisional until billing
     * promotes/reconciles the org. See docs/tech-debt.md "Org tier billing reconciliation".
     */
    tier: z.enum(['free', 'pro', 'business', 'enterprise']).default('business'),
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
