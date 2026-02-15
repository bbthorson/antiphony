"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const records_1 = require("./records");
(0, vitest_1.describe)('Record Schemas', () => {
    const validReplyBase = {
        id: 'reply-1',
        promptId: 'prompt-1',
        authorId: 'user-1',
        audioUrl: 'https://example.com/audio.webm',
        createdAt: new Date(),
        status: 'live',
    };
    const validPromptBase = {
        id: 'prompt-1',
        authorId: 'user-1',
        title: 'Test Prompt',
        audioUrl: 'https://example.com/audio.webm',
        createdAt: new Date(),
        status: 'live',
    };
    (0, vitest_1.describe)('ReplyRecordSchema AI Enrichment', () => {
        (0, vitest_1.it)('should allow valid AI fields on a reply', () => {
            const replyWithAI = Object.assign(Object.assign({}, validReplyBase), { transcription: 'Hello world', aiStatus: 'complete', aiSummary: 'A test summary', aiLabels: ['test', 'audio'], sentiment: 'Positive', energyLevel: 'High', engagementScore: 8 });
            const result = records_1.ReplyRecordSchema.safeParse(replyWithAI);
            (0, vitest_1.expect)(result.success).toBe(true);
        });
        (0, vitest_1.it)('should validate engagementScore range', () => {
            const invalidReply = Object.assign(Object.assign({}, validReplyBase), { engagementScore: 11 });
            const result = records_1.ReplyRecordSchema.safeParse(invalidReply);
            (0, vitest_1.expect)(result.success).toBe(false);
        });
        (0, vitest_1.it)('should validate aiStatus enum', () => {
            const invalidReply = Object.assign(Object.assign({}, validReplyBase), { aiStatus: 'finished' });
            const result = records_1.ReplyRecordSchema.safeParse(invalidReply);
            (0, vitest_1.expect)(result.success).toBe(false);
        });
    });
    (0, vitest_1.describe)('PromptRecordSchema AI Enrichment', () => {
        (0, vitest_1.it)('should allow valid AI fields on a prompt', () => {
            const promptWithAI = Object.assign(Object.assign({}, validPromptBase), { transcription: 'Creator prompt text', aiStatus: 'complete', aiSummary: 'A summary of the prompt', aiLabels: ['creator', 'test'] });
            const result = records_1.PromptRecordSchema.safeParse(promptWithAI);
            (0, vitest_1.expect)(result.success).toBe(true);
        });
    });
});
