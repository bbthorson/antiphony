import { z } from 'zod';

export const UpdateAuthorDataRequestSchema = z.object({
  replyId: z.string(),
  data: z.object({
    isVerified: z.boolean().optional(),
    authorRating: z.number().optional(), // Renamed from creatorRating
    authorTags: z.array(z.string().max(50)).max(20).optional(), // Renamed from creatorTags
    notes: z.string().max(5000).optional(),
  }),
});

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
});

export const UpdateProfileRequestSchema = z.object({
  handle: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/).optional(),
  displayName: z.string().max(50).optional(),
  bio: z.string().max(160).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  usageIntent: z.string().nullable().optional(),
});

export const FcmTokenRequestSchema = z.object({
  token: z.string().min(1)
});

export const BadgeResetRequestSchema = z.object({
  type: z.enum(['new_replier', 'unread_reply'])
});
