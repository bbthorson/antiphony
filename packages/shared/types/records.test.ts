import { describe, it, expect } from 'vitest';
import { ReplyRecordSchema, PromptRecordSchema } from './records';

describe('Record Schemas', () => {
    const validReplyBase = {
        id: 'reply-1',
        promptId: 'prompt-1',
        authorId: 'user-1',
        audioUrl: 'https://example.com/audio.webm',
        createdAt: new Date(),
        status: 'live' as const,
    };

    const validPromptBase = {
        id: 'prompt-1',
        authorId: 'user-1',
        title: 'Test Prompt',
        audioUrl: 'https://example.com/audio.webm',
        createdAt: new Date(),
        status: 'live' as const,
    };

    describe('ReplyRecordSchema AI Enrichment', () => {
        it('should allow valid AI fields on a reply', () => {
            const replyWithAI = {
                ...validReplyBase,
                transcription: 'Hello world',
                aiStatus: 'complete' as const,
                aiSummary: 'A test summary',
                aiLabels: ['test', 'audio'],
                sentiment: 'Positive' as const,
                energyLevel: 'High' as const,
                engagementScore: 8,
            };

            const result = ReplyRecordSchema.safeParse(replyWithAI);
            expect(result.success).toBe(true);
        });

        it('should validate engagementScore range', () => {
            const invalidReply = {
                ...validReplyBase,
                engagementScore: 11,
            };
            const result = ReplyRecordSchema.safeParse(invalidReply);
            expect(result.success).toBe(false);
        });

        it('should validate aiStatus enum', () => {
            const invalidReply = {
                ...validReplyBase,
                aiStatus: 'finished',
            };
            const result = ReplyRecordSchema.safeParse(invalidReply);
            expect(result.success).toBe(false);
        });
    });

    describe('PromptRecordSchema AI Enrichment', () => {
        it('should allow valid AI fields on a prompt', () => {
            const promptWithAI = {
                ...validPromptBase,
                transcription: 'Creator prompt text',
                aiStatus: 'complete' as const,
                aiSummary: 'A summary of the prompt',
                aiLabels: ['creator', 'test'],
            };

            const result = PromptRecordSchema.safeParse(promptWithAI);
            expect(result.success).toBe(true);
        });
    });
});
