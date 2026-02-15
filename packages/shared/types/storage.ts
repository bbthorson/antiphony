import { z } from 'zod';
import { PromptRecordSchema, FirestoreTimestampSchema, ReplyRecordSchema } from './records';

// This is what actually sits in your Firestore 'prompts' collection
// It acts as the "AppView" cache for the Prompt Record
export const PromptDocumentSchema = PromptRecordSchema.extend({
    replyCount: z.number().default(0), // Computed field lives here
    lastReplyAt: FirestoreTimestampSchema.optional(), // Good for sorting feeds
});

export type PromptDocument = z.infer<typeof PromptDocumentSchema>;

/**
 * The ReplyDocument (Storage Schema).
 * Currently identical to ReplyRecordSchema as there are no computed fields stored on the Reply document itself.
 */
export const ReplyDocumentSchema = ReplyRecordSchema;
export type ReplyDocument = z.infer<typeof ReplyDocumentSchema>;
