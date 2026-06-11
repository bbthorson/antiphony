import { z } from 'zod';
import { CallForwardingConfigSchema } from './types/records';

export const CreatePromptRequestSchema = z.object({
  // Bounds chosen so the public prompt hero never needs to clip: title +
  // description sit between the two dots inside an h-dvh, overflow-hidden
  // layout. 80/200 keeps typical content to a few lines on short phones.
  // (Record-level schema stays unbounded so any pre-existing longer values
  // still read cleanly — this only gates new writes.)
  title: z.string().min(3).max(80),
  description: z.string().max(200).optional(),
  audioUrl: z.string().url().or(z.literal('')),
  setAsGreeting: z.union([z.boolean(), z.string().transform(val => val === 'true')]).optional(),
  /** Explicit org context override (normally inferred from auth.currentOrg) */
  orgId: z.string().nullable().optional(),
});

export const UpdateProfileRequestSchema = z.object({
  handle: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/).optional(),
  displayName: z.string().max(50).optional(),
  bio: z.string().max(160).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  usageIntent: z.string().max(200).nullable().optional(),
  /**
   * Personal website surfaced on the public profile. Accepts a URL, empty
   * string, or null from the client; normalizes empty string → null so the
   * value stored on `UserRecord` (which requires `.url() | null`) round-trips
   * cleanly through `UserRecordSchema.parse` on subsequent reads.
   */
  website: z.union([z.string().url(), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v === '' ? null : v)),
  /** Up to 5 public links (label + URL) shown under the bio. */
  links: z.array(z.object({
    label: z.string().min(1).max(40),
    url: z.string().url(),
  })).max(5).optional(),
  /** When true, surfaces the linked Bluesky identity on the public profile. */
  showBlueskyPublicly: z.boolean().optional(),
});

export const FcmTokenRequestSchema = z.object({
  // FCM registration tokens are typically ~163–200 chars; Google's docs
  // don't publish a hard max but 4096 is a safe upper bound that prevents
  // multi-MB payloads while accommodating any plausible FCM token format.
  token: z.string().min(1).max(4096),
});

export const BadgeResetRequestSchema = z.object({
  type: z.enum(['new_replier', 'unread_reply'])
});

// Organization management
export const CreateOrgRequestSchema = z.object({
  name: z.string().min(3).max(50),
  slug: z.string().min(3).max(30).regex(/^[a-z0-9-]+$/),
  avatarUrl: z.string().url().optional(),
  rssFeedUrl: z.string().url().optional(),
  websiteUrl: z.string().url().optional(),
  // 500 chars — enough for a multi-sentence blurb, prevents multi-MB writes.
  description: z.string().max(500).optional(),
});

export const UpdateOrgRequestSchema = z.object({
  name: z.string().min(3).max(50).optional(),
  slug: z.string().min(3).max(30).regex(/^[a-z0-9-]+$/).optional(),
  // 500 chars — matches CreateOrgRequestSchema.description.
  description: z.string().max(500).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  rssFeedUrl: z.string().url().nullable().optional(),
  websiteUrl: z.string().url().nullable().optional(),
  billingEmail: z.string().email().nullable().optional(),
  // 253 chars — the DNS spec maximum for a fully-qualified domain name.
  domain: z.string().max(253).nullable().optional(),
});

export const CreateOrgInviteRequestSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']),
});

export const UpdateMemberRoleRequestSchema = z.object({
  role: z.enum(['admin', 'member']),
});

export const SwitchOrgRequestSchema = z.object({
  /** orgId to switch to, or null to switch to personal context */
  orgId: z.string().nullable(),
});

// Call-forwarding data layer (canonical CRUD; Twilio orchestration lives in apps/telephony/).
// Server stamps `createdAt` / `updatedAt`, so both shapes omit them. PR-E1 in
// the Post-4a roadmap added the core-api endpoints; apps/telephony/ POSTs the
// already-Twilio-resolved config and PATCHes verification-state transitions.
export const CallForwardingConfigInputSchema = CallForwardingConfigSchema.omit({
  createdAt: true,
  updatedAt: true,
});

export const CallForwardingConfigUpdateSchema = CallForwardingConfigInputSchema.partial();

// People enrichment (apps/identity tier-2). Per-viewer CRM notes/tags + merge.
// Bounds mirror the legacy inline schema in core-api's people.ts notes route
// (notes ≤10K; ≤50 tags, each ≤64 chars). Both fields optional so partial
// merge-writes don't clobber the other.
export const PersonNotesUpdateSchema = z.object({
  notes: z.string().max(10_000).optional(),
  tags: z.array(z.string().max(64)).max(50).optional(),
});

// Identity-merge: declare `alternateUid` to be the same person as the target
// uid in the path. Viewer-scoped; collapses the alternate into the primary in
// the People read-path.
export const PersonMergeRequestSchema = z.object({
  alternateUid: z.string().min(1),
});

// Screening allowlist (consumer-call-app § 5). Server stamps id/ownerId/
// createdAt and sets source='manual' for API-created rules (contact-sync /
// callback writers go through the service directly). `expiresAt` accepts an
// ISO string or epoch-ms; null/omitted = permanent. The `.refine` rejects
// unparseable dates at the request boundary (a clean 400 with a clear
// message) rather than letting them surface as a generic Validation Error
// from deep in FirestoreTimestampSchema when the service re-parses.
export const ScreeningRuleInputSchema = z.object({
  e164: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Must be an E.164 phone number'),
  label: z.string().max(120).nullable().optional(),
  action: z.enum(['allow', 'screen']),
  expiresAt: z
    .union([z.string(), z.number()])
    .nullable()
    .optional()
    .refine((v) => v == null || !Number.isNaN(new Date(v).getTime()), {
      message: 'Must be a valid ISO date string or epoch-ms timestamp',
    }),
});
export const ScreeningRuleUpdateSchema = ScreeningRuleInputSchema.partial();

// Reply lifecycle management
export const UpdateReplyStatusRequestSchema = z.object({
  status: z.enum(['live', 'archived', 'deleted']),
});

// Bulk reply actions
export const BulkReplyActionRequestSchema = z.object({
  replyIds: z.array(z.string()).min(1).max(100),
  action: z.enum(['markRead', 'archive', 'delete', 'restore']),
});
