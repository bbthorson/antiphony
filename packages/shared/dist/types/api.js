"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActorViewSchema = exports.PublicReplyDtoSchema = exports.PublicProfileDtoSchema = void 0;
const zod_1 = require("zod");
const records_1 = require("./records");
const views_1 = require("./views");
// #region DTOs (Public API Contracts)
// =================================================================================================
/**
 * Public Profile DTO — the public-facing profile shape.
 * Equivalent to ProfileViewBasicSchema plus a few enrichment fields.
 */
exports.PublicProfileDtoSchema = views_1.ProfileViewBasicSchema.extend({
    bluesky: zod_1.z.object({
        handle: zod_1.z.string(),
        did: zod_1.z.string(),
    }).optional(),
    rssFeedUrl: zod_1.z.string().optional().nullable(),
});
/**
 * Public Reply DTO
 * Excludes internal fields or sensitive metadata if any.
 */
exports.PublicReplyDtoSchema = zod_1.z.object({
    id: zod_1.z.string(),
    audioUrl: zod_1.z.string().url(),
    duration: zod_1.z.number().optional(),
    createdAt: records_1.FirestoreTimestampSchema,
    transcription: zod_1.z.string().optional(),
    sentiment: zod_1.z.enum(['Positive', 'Negative', 'Neutral']).optional(),
    aiSummary: zod_1.z.string().optional(),
    author: exports.PublicProfileDtoSchema,
});
/**
 * Actor View — the full view returned to the authenticated user about themselves.
 * Uses ProfileViewSelfSchema which includes private settings but not admin fields.
 */
exports.ActorViewSchema = views_1.ProfileViewSelfSchema;
// #endregion
