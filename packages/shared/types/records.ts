import { z } from 'zod';

// #region URL Helpers
// =================================================================================================

/**
 * Reusable http/https scheme allowlist refinement.
 *
 * `z.string().url()` accepts any scheme including `javascript:`, `data:`, and
 * `vbscript:`, which are stored-XSS vectors when values land in an `<a href>`.
 * Wrap any user-supplied URL field with this helper instead of bare `.url()`.
 *
 * Usage:
 *   website: httpsUrl().nullable().optional()
 *   url:     httpsUrl()
 *
 * Audit ref: M7 — javascript: URLs in profile links.
 */
export function httpsUrl() {
    return z
        .string()
        .trim() // normalize accidental copy/paste whitespace before validating
        .url()
        .refine((u) => /^https?:\/\//i.test(u), {
            message: 'URL must use the http or https scheme',
        });
}

// #endregion

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
 * The raw actor (user) identity record stored in Firestore.
 *
 * This is the canonical identity record for the Antiphony actor surface.
 * Audio content lives in `dev.antiphony.audio.post` (see `types/audio.ts`),
 * never on the user record.
 */
export const UserRecordSchema = z.object({
    /** Unique Firebase UID */
    id: z.string(),
    /** Public handle (e.g. @brad). Optional for Lite Users. */
    handle: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/).nullable().optional(),

    /** User stated intent (e.g. "Podcaster", "Listener") */
    usageIntent: z.string().nullable().optional(),
    /** Domain for federated handle support. */
    domain: z.string().default('antiphony.dev'),
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
    website: httpsUrl().nullable().optional(),
    /** Up to 5 additional public links (label + URL) shown under the bio. */
    links: z.array(z.object({
        label: z.string().min(1).max(40),
        url: httpsUrl(),
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
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

// #endregion
