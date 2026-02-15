"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BetaSignupRequestSchema = exports.UpdateProfileRequestSchema = exports.CreatePromptRequestSchema = exports.SubmitReplyRequestSchema = exports.CheckPhoneRequestSchema = exports.UpdateAuthorDataRequestSchema = void 0;
const zod_1 = require("zod");
exports.UpdateAuthorDataRequestSchema = zod_1.z.object({
    replyId: zod_1.z.string(),
    data: zod_1.z.object({
        isVerified: zod_1.z.boolean().optional(),
        authorRating: zod_1.z.number().optional(), // Renamed from creatorRating
        authorTags: zod_1.z.array(zod_1.z.string().max(50)).max(20).optional(), // Renamed from creatorTags
        authorNotes: zod_1.z.string().max(5000).optional(), // Renamed from creatorNotes
    }),
});
exports.CheckPhoneRequestSchema = zod_1.z.object({
    phoneNumber: zod_1.z.string().max(20),
});
exports.SubmitReplyRequestSchema = zod_1.z.object({
    phoneNumber: zod_1.z.string().max(20),
    otp: zod_1.z.string().max(10),
    audioUrl: zod_1.z.string().url(),
    promptId: zod_1.z.string(),
    userId: zod_1.z.string(),
});
exports.CreatePromptRequestSchema = zod_1.z.object({
    title: zod_1.z.string().min(3).max(100),
    description: zod_1.z.string().max(1000).optional(),
    audioUrl: zod_1.z.string().url().or(zod_1.z.literal('')),
    setAsGreeting: zod_1.z.union([zod_1.z.boolean(), zod_1.z.string().transform(val => val === 'true')]).optional(),
});
exports.UpdateProfileRequestSchema = zod_1.z.object({
    handle: zod_1.z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/).optional(),
    displayName: zod_1.z.string().max(50).optional(),
    bio: zod_1.z.string().max(160).optional(),
    avatarUrl: zod_1.z.string().url().optional().nullable(),
    rssFeedUrl: zod_1.z.string().url().optional().nullable(),
    usageIntent: zod_1.z.string().optional().nullable(),
});
exports.BetaSignupRequestSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    usageIntent: zod_1.z.string().min(3).max(500),
    inviteCode: zod_1.z.string().optional(),
});
