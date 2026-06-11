import { describe, it, expect } from 'vitest';
import { ReplyRecordSchema, PromptRecordSchema, FirestoreTimestampSchema, UserRecordSchema, OrganizationRecordSchema } from './records';

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

    describe('ReplyRecordSchema canonical shape', () => {
        // Post Stage 4 of the AI-enrichment split, the canonical record no
        // longer declares AI-cluster fields — those live on the enrichment
        // doc (see `ReplyEnrichmentRecordSchema`). Old AI-validation tests
        // here became no-ops because Zod silently strips undeclared keys.

        it('parses the minimal canonical shape', () => {
            const result = ReplyRecordSchema.safeParse(validReplyBase);
            expect(result.success).toBe(true);
        });

        it('accepts waveformPeaks + audioDurationSec (ffmpeg outputs, stay canonical per spec § 5)', () => {
            const result = ReplyRecordSchema.safeParse({
                ...validReplyBase,
                waveformPeaks: [0.1, 0.5, 0.3],
                audioDurationSec: 12.5,
            });
            expect(result.success).toBe(true);
        });

        it('strips AI-cluster fields silently — they live on the enrichment doc, not canonical', () => {
            const result = ReplyRecordSchema.safeParse({
                ...validReplyBase,
                aiStatus: 'complete',
                transcription: 'Hello world',
                sentiment: 'Positive',
                enhancedAudioUrl: 'https://example.com/enhanced.webm',
                socialVideoUrl: 'https://example.com/video.mp4',
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect((result.data as Record<string, unknown>).aiStatus).toBeUndefined();
                expect((result.data as Record<string, unknown>).transcription).toBeUndefined();
                expect((result.data as Record<string, unknown>).enhancedAudioUrl).toBeUndefined();
                expect((result.data as Record<string, unknown>).socialVideoUrl).toBeUndefined();
            }
        });
    });

    // -----------------------------------------------------------------------
    // M7 — URL scheme allowlist on UserRecordSchema
    // -----------------------------------------------------------------------
    describe('UserRecordSchema URL scheme validation (M7)', () => {
        const base = {
            id: 'user-1',
            createdAt: new Date(),
        };

        it('accepts https website', () => {
            const result = UserRecordSchema.safeParse({ ...base, website: 'https://example.com' });
            expect(result.success).toBe(true);
        });

        it('accepts http website (legacy plain-http sites)', () => {
            const result = UserRecordSchema.safeParse({ ...base, website: 'http://example.com' });
            expect(result.success).toBe(true);
        });

        it('rejects javascript: website (XSS vector)', () => {
            const result = UserRecordSchema.safeParse({ ...base, website: 'javascript:alert(1)' });
            expect(result.success).toBe(false);
        });

        it('rejects data: website', () => {
            const result = UserRecordSchema.safeParse({ ...base, website: 'data:text/html,<script>alert(1)</script>' });
            expect(result.success).toBe(false);
        });

        it('trims surrounding whitespace on website', () => {
            const result = UserRecordSchema.safeParse({ ...base, website: '  https://example.com  ' });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.website).toBe('https://example.com');
        });

        it('accepts https links[].url', () => {
            const result = UserRecordSchema.safeParse({
                ...base,
                links: [{ label: 'Blog', url: 'https://blog.example.com' }],
            });
            expect(result.success).toBe(true);
        });

        it('rejects javascript: links[].url', () => {
            const result = UserRecordSchema.safeParse({
                ...base,
                links: [{ label: 'Evil', url: 'javascript:void(0)' }],
            });
            expect(result.success).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // M7 — URL scheme allowlist on OrganizationRecordSchema
    // -----------------------------------------------------------------------
    describe('OrganizationRecordSchema URL scheme validation (M7)', () => {
        const base = {
            id: 'org-1',
            name: 'My Org',
            slug: 'my-org',
            ownerId: 'user-1',
            createdAt: new Date(),
        };

        it('accepts https websiteUrl', () => {
            const result = OrganizationRecordSchema.safeParse({ ...base, websiteUrl: 'https://myorg.com' });
            expect(result.success).toBe(true);
        });

        it('rejects javascript: websiteUrl', () => {
            const result = OrganizationRecordSchema.safeParse({ ...base, websiteUrl: 'javascript:alert(1)' });
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
