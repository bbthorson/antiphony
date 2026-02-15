"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReplyDocumentSchema = exports.PromptDocumentSchema = void 0;
const zod_1 = require("zod");
const records_1 = require("./records");
// This is what actually sits in your Firestore 'prompts' collection
// It acts as the "AppView" cache for the Prompt Record
exports.PromptDocumentSchema = records_1.PromptRecordSchema.extend({
    replyCount: zod_1.z.number().default(0), // Computed field lives here
    lastReplyAt: records_1.FirestoreTimestampSchema.optional(), // Good for sorting feeds
});
/**
 * The ReplyDocument (Storage Schema).
 * Currently identical to ReplyRecordSchema as there are no computed fields stored on the Reply document itself.
 */
exports.ReplyDocumentSchema = records_1.ReplyRecordSchema;
