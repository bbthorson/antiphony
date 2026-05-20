import { describe, it, expect } from 'vitest';
import { ReplyRecordSchema, PromptRecordSchema, FirestoreTimestampSchema } from './records';

describe('FirestoreTimestampSchema', () => {
    it('accepts a valid ISO string', () => {
        const result = FirestoreTimestampSchema.safeParse('2026-05-19T12:00:00.000Z');
        expect(result.success).toBe(true);
        if (result.success) expect(result.data).toBeInstanceOf(Date);
    });

    it('accepts a Date object', () => {
        const now = new Date();
        const result = FirestoreTimestampSchema.safeParse(now);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.getTime()).toBe(now.getTime());
    });

    it('accepts an epoch number', () => {
        const result = FirestoreTimestampSchema.safeParse(1_700_000_000_000);
        expect(result.success).toBe(true);
    });

    it('accepts a Firestore Timestamp object (toDate())', () => {
        const ts = { toDate: () => new Date('2026-05-19T12:00:00.000Z') };
        const result = FirestoreTimestampSchema.safeParse(ts);
        expect(result.success).toBe(true);
    });

    it('accepts a serialized Firestore Timestamp shape ({seconds, nanoseconds})', () => {
        const ts = { seconds: 1_700_000_000, nanoseconds: 0 };
        const result = FirestoreTimestampSchema.safeParse(ts);
        expect(result.success).toBe(true);
    });

    it('REJECTS an empty string (would coerce to Invalid Date)', () => {
        const result = FirestoreTimestampSchema.safeParse('');
        expect(result.success).toBe(false);
    });

    it('REJECTS a garbage string (would coerce to Invalid Date)', () => {
        const result = FirestoreTimestampSchema.safeParse('not-a-date');
        expect(result.success).toBe(false);
    });

    it('REJECTS NaN as a number', () => {
        const result = FirestoreTimestampSchema.safeParse(NaN);
        expect(result.success).toBe(false);
    });
});

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
