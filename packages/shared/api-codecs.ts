import { z } from 'zod';
import { CallForwardingConfigSchema } from './types/records';

export const CheckPhoneRequestSchema = z.object({
  phoneNumber: z.string().max(20),
});

export const SubmitReplyRequestSchema = z.object({
  phoneNumber: z.string().max(20),
  otp: z.string().max(10),
  audioUrl: z.string().url(),
  promptId: z.string(),
  userId: z.string(),
});

export const CreatePromptRequestSchema = z.object({
  title: z.string().min(3).max(100),
  description: z.string().max(1000).optional(),
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
  usageIntent: z.string().nullable().optional(),
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
  token: z.string().min(1)
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
  description: z.string().optional(),
});

export const UpdateOrgRequestSchema = z.object({
  name: z.string().min(3).max(50).optional(),
  slug: z.string().min(3).max(30).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  rssFeedUrl: z.string().url().nullable().optional(),
  websiteUrl: z.string().url().nullable().optional(),
  billingEmail: z.string().email().nullable().optional(),
  domain: z.string().nullable().optional(),
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

// Reply lifecycle management
export const UpdateReplyStatusRequestSchema = z.object({
  status: z.enum(['live', 'archived', 'deleted']),
});

// Bulk reply actions
export const BulkReplyActionRequestSchema = z.object({
  replyIds: z.array(z.string()).min(1).max(100),
  action: z.enum(['markRead', 'archive', 'delete', 'restore']),
});
