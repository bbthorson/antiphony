import { describe, it, expect } from 'vitest';
import { FirestoreTimestampSchema, UserRecordSchema } from './records';

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
