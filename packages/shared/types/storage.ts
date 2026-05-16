import { z } from 'zod';
import { PromptRecordSchema, FirestoreTimestampSchema, ReplyRecordSchema } from './records';

// This is what actually sits in your Firestore 'prompts' collection
// It acts as the "AppView" cache for the Prompt Record
export const PromptDocumentSchema = PromptRecordSchema.extend({
    replyCount: z.number().default(0), // Computed field lives here
    lastReplyAt: FirestoreTimestampSchema.optional(), // Good for sorting feeds
    // Per-prompt aggregates over `status: 'live'` replies whose AI enrichment
    // landed (sentiment + engagementScore). Maintained by the AI-enrichment
    // trigger and the reply-status-flip path via FieldValue.increment deltas.
    // Sum + count rather than a pre-divided average: only sum/count compose
    // safely under concurrent writes (no read-modify-write).
    engagementScoreSum: z.number().default(0),
    engagementScoreCount: z.number().default(0),
    sentimentCounts: z.object({
        positive: z.number().default(0),
        neutral: z.number().default(0),
        negative: z.number().default(0),
    }).default({ positive: 0, neutral: 0, negative: 0 }),
});

export type PromptDocument = z.infer<typeof PromptDocumentSchema>;

/**
 * The ReplyDocument (Storage Schema).
 * Currently identical to ReplyRecordSchema as there are no computed fields stored on the Reply document itself.
 */
export const ReplyDocumentSchema = ReplyRecordSchema;
export type ReplyDocument = z.infer<typeof ReplyDocumentSchema>;
