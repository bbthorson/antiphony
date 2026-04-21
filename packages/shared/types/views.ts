import { z } from 'zod';
import { FirestoreTimestampSchema, OrganizationRecordSchema, OrganizationMemberRecordSchema, OrgInviteRecordSchema, PromptRecordSchema, ReplyRecordSchema } from './records';

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
    // `.optional()` alone rejects `null`. This hit dashboard rendering on the
    // Phase 3.1 HTTP cutover, when transport-layer Zod validation started
    // actually exercising the wire shape. Consumers already use truthy
    // checks / `??` / `||`, so widening the type to include `null` is safe.
    displayName: z.string().nullable().optional(),
    avatarUrl: z.string().nullable().optional(),
    bio: z.string().nullable().optional(),
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
 *
 * Mirrors `toPromptViewPublic` / `toReplyViewPublic`: plain-object projection,
 * no Zod re-validation in the hot path.
 */
export function toProfileViewBasic(profile: {
    id: string;
    handle?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    bio?: string | null;
    stats?: { followers: number; following: number; prompts: number };
    badges?: string[];
    isVerified?: boolean;
    createdAt?: unknown;
}): ProfileViewBasic {
    const { id, handle, displayName, avatarUrl, bio, stats, badges, isVerified, createdAt } = profile;
    return { id, handle, displayName, avatarUrl, bio, stats, badges, isVerified, createdAt } as ProfileViewBasic;
}

/** Authenticated viewer — includes enrichment data visible to other users. */
export const ProfileViewDetailedSchema = ProfileViewBasicSchema.extend({
    /** AT Protocol Identity link */
    bluesky: z.object({
        handle: z.string(),
        did: z.string(),
    }).optional(),

    usageIntent: z.string().nullable().optional(),
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
    /** @deprecated Use stats.prompts from ProfileViewBasic instead */
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
 * Public-safe PromptView schema — strips owner-only enrichment fields AND
 * narrows the nested `author` to `ProfileViewBasicSchema` so PII (email,
 * phone, lastSeen, reply counts) and admin fields (blockedUsers, moderation
 * counters, ban state) never cross the public API boundary.
 *
 * Mirrors `ReplyViewPublicSchema`'s omit pattern, plus a deliberate
 * `.extend({ author })` to enforce the narrower profile shape. The API
 * contract itself now reflects the intended public surface — future
 * callers can't accidentally leak admin fields through the author slot.
 */
export const PromptViewPublicSchema = PromptViewSchema.omit({
    analytics: true,
    moderation: true,
    aiScore: true,
    aiLabels: true,
    aiSummary: true,
    aiStatus: true,
    aiError: true,
    transcription: true,
}).extend({
    author: ProfileViewBasicSchema,
});
export type PromptViewPublic = z.infer<typeof PromptViewPublicSchema>;

/**
 * Strips owner-only enrichment fields from a PromptView AND narrows the
 * nested author to `ProfileViewBasic` shape. Defense-in-depth against PII
 * leakage: even if a caller forgets to validate against
 * `PromptViewPublicSchema`, the returned object only carries the basic
 * author fields.
 *
 * Does not re-validate with Zod (matches the `toReplyViewPublic` pattern
 * — re-validation in the hot path of every public response is
 * prohibitively expensive for a defensive copy).
 */
export function toPromptViewPublic(prompt: PromptView): PromptViewPublic {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { analytics, moderation, aiScore, aiLabels, aiSummary, aiStatus, aiError, transcription, ...rest } = prompt;
    const { id, handle, displayName, avatarUrl, bio, stats, badges, isVerified, createdAt } = rest.author;
    /* eslint-enable @typescript-eslint/no-unused-vars */
    return {
        ...rest,
        author: { id, handle, displayName, avatarUrl, bio, stats, badges, isVerified, createdAt },
    };
}


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
    aiStatus: z.enum(['pending', 'complete', 'error', 'skipped_too_short']).optional(),
    aiError: z.string().optional(),
    transcription: z.string().optional(),
    sentiment: z.enum(['Positive', 'Negative', 'Neutral']).optional(),
    /** Must match the widened enum in `ReplyRecordSchema.energyLevel`. */
    energyLevel: z.enum(['High', 'Low', 'Neutral']).optional(),
    engagementScore: z.number().min(1).max(10).optional(),
    /** @private Confirmed listener phone number (never exposed publicly) */
    listenerPhoneNumber: z.string().regex(/^\+[1-9]\d{1,14}$/).optional(),
    isVerified: z.boolean().default(false),
    /** @private Author's rating of this reply (only visible to prompt author) */
    authorRating: z.number().optional(),
    /** @private Author's tags for this reply (only visible to prompt author) */
    authorTags: z.array(z.string()).optional(),
    /** @private Author's notes on this reply (only visible to prompt author) */
    authorNotes: z.string().optional(),
});
export type ReplyView = z.infer<typeof ReplyViewSchema>;

/**
 * Public-safe ReplyView schema — strips PII and author-private CRM fields.
 * Use this for ALL client-facing API responses. Keep ReplyView for internal/service use only.
 *
 * Note: listenerPhoneNumber is not currently populated during hydration, but this schema
 * provides defense-in-depth in case Firestore documents contain the field from SIP/phone flows.
 */
export const ReplyViewPublicSchema = ReplyViewSchema.omit({
    listenerPhoneNumber: true,
    authorRating: true,
    authorTags: true,
    authorNotes: true,
});
export type ReplyViewPublic = z.infer<typeof ReplyViewPublicSchema>;

/**
 * Strips private fields from a ReplyView, returning a client-safe object.
 * Works on plain objects (does not re-validate with Zod for performance).
 *
 * Strips both top-level private fields AND `record.notes` (per-reply author notes
 * are private CRM data stored on the Firestore document as `notes`).
 */
export function toReplyViewPublic(reply: ReplyView): ReplyViewPublic {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { listenerPhoneNumber, authorRating, authorTags, authorNotes, ...publicReply } = reply;
    // Also strip notes from the nested record (private CRM field)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { notes: _notes, ...publicRecord } = publicReply.record;
    return { ...publicReply, record: { ...publicRecord } } as ReplyViewPublic;
}



// #endregion

// #region Organization Views
// =================================================================================================

export const OrganizationViewSchema = z.object({
    record: OrganizationRecordSchema,
    memberCount: z.number().default(1),
    currentUserRole: z.enum(['owner', 'admin', 'member']).optional(),
});
export type OrganizationView = z.infer<typeof OrganizationViewSchema>;

export const OrganizationMemberViewSchema = z.object({
    record: OrganizationMemberRecordSchema,
    profile: ProfileViewBasicSchema,
});
export type OrganizationMemberView = z.infer<typeof OrganizationMemberViewSchema>;

export const OrgInviteViewSchema = z.object({
    record: OrgInviteRecordSchema,
    /** Display name of the user who sent the invite */
    inviterName: z.string().optional(),
    /** Name of the organization */
    orgName: z.string(),
});
export type OrgInviteView = z.infer<typeof OrgInviteViewSchema>;

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

/**
 * Prompt joined with its hydrated replies. The serverProxy HTTP transport
 * sends `replies: []` today (replies are fetched client-side on demand), but
 * the shape is kept for parity with the in-process service.
 */
export const PromptWithRepliesSchema = PromptViewSchema.extend({
    replies: z.array(ReplyViewSchema),
});
export type PromptWithReplies = z.infer<typeof PromptWithRepliesSchema>;

/**
 * Per-replier summary (handle + counts + first/last reply timestamps).
 * Timestamps are ISO strings on the wire; the service serializes them before
 * returning.
 */
export const ReplierSchema = z.object({
    handle: z.string(),
    /** ISO date string */
    lastReplyDate: z.string(),
    /** ISO date string */
    firstReplyAt: z.string(),
    totalReplies: z.number(),
});
export type Replier = z.infer<typeof ReplierSchema>;

/**
 * Discriminated union returned by `feedService.resolveHandle`. Either a user
 * (when the handle resolves to a user profile) or an organization (when it
 * resolves to an org slug). The service returns `null` when neither matches —
 * callers that need the null case should wrap this in `.nullable()`.
 */
export const HandleResolutionSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('user'), profile: ProfileViewSchema }),
    z.object({ type: z.literal('org'), org: OrganizationViewSchema }),
]);
export type HandleResolution = z.infer<typeof HandleResolutionSchema>;

/**
 * Aggregated payload returned by `feedService.getUserProfileData` —
 * profile + their prompts (with empty replies arrays) + repliers summary.
 */
export const UserProfileDataSchema = z.object({
    profileUser: ProfileViewSchema,
    allPromptsWithReplies: z.array(PromptWithRepliesSchema),
    repliers: z.array(ReplierSchema),
});
export type UserProfileData = z.infer<typeof UserProfileDataSchema>;

/**
 * RSS feed summary schema — what `rssService.parseFeed` returns. Kept as a
 * shared schema because both the profile-detailed view and the org-profile
 * aggregated payload embed it. The original interface lives in
 * `packages/core/services/rss.ts`; this schema mirrors its shape for
 * runtime validation at the transport layer.
 */
export const RssSummarySchema = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    link: z.string().optional(),
    items: z.array(z.object({
        title: z.string().optional(),
        link: z.string().optional(),
        content: z.string().optional(),
        pubDate: z.string().optional(),
    })).optional(),
    lastFetchedAt: FirestoreTimestampSchema.optional(),
});
export type RssSummary = z.infer<typeof RssSummarySchema>;

/**
 * Aggregated payload returned by `feedService.getOrgProfileData` — org
 * details, org-context prompts (live only), and the RSS summary if the
 * org has `rssFeedUrl` configured.
 */
export const OrgProfileDataSchema = z.object({
    org: OrganizationViewSchema,
    prompts: z.array(PromptViewSchema),
    rssSummary: RssSummarySchema.nullable(),
});
export type OrgProfileData = z.infer<typeof OrgProfileDataSchema>;

/** Enriched replier with full profile data for CRM views */
export const EnrichedReplierSchema = z.object({
    profile: ProfileViewBasicSchema,
    totalReplies: z.number(),
    /** ISO date string */
    lastReplyDate: z.string(),
    /** ISO date string */
    firstReplyAt: z.string(),
    /** Phone number for anonymous repliers (from Firebase Auth, only visible to prompt author) */
    phoneNumber: z.string().optional(),
});
export type EnrichedReplier = z.infer<typeof EnrichedReplierSchema>;

/** Person-level CRM data (private to prompt author) */
export interface ContactCrmData {
    notes: string;
    tags: string[];
    lastUpdated: string; // ISO date string
}


// #endregion


