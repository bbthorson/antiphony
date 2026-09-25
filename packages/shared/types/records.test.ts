import { describe, it, expect } from 'vitest';
import { TimestampSchema } from './records';

describe('TimestampSchema', () => {
    it('accepts a valid ISO string', () => {
        const result = TimestampSchema.safeParse('2026-05-19T12:00:00.000Z');
        expect(result.success).toBe(true);
        if (result.success) expect(result.data).toBeInstanceOf(Date);
    });

    it('accepts a Date object', () => {
        const now = new Date();
        const result = TimestampSchema.safeParse(now);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.getTime()).toBe(now.getTime());
    });

    it('accepts an epoch number', () => {
        const result = TimestampSchema.safeParse(1_700_000_000_000);
        expect(result.success).toBe(true);
    });

    it('accepts a timestamp object with toDate()', () => {
        const ts = { toDate: () => new Date('2026-05-19T12:00:00.000Z') };
        const result = TimestampSchema.safeParse(ts);
        expect(result.success).toBe(true);
    });

    it('accepts a serialized timestamp shape ({seconds, nanoseconds})', () => {
        const ts = { seconds: 1_700_000_000, nanoseconds: 0 };
        const result = TimestampSchema.safeParse(ts);
        expect(result.success).toBe(true);
    });

    it('REJECTS an empty string (would coerce to Invalid Date)', () => {
        const result = TimestampSchema.safeParse('');
        expect(result.success).toBe(false);
    });

    it('REJECTS a garbage string (would coerce to Invalid Date)', () => {
        const result = TimestampSchema.safeParse('not-a-date');
        expect(result.success).toBe(false);
    });

    it('REJECTS NaN as a number', () => {
        const result = TimestampSchema.safeParse(NaN);
        expect(result.success).toBe(false);
    });
});
