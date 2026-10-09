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

    it('accepts the text form of a timestamptz column', () => {
        const result = TimestampSchema.safeParse('2026-05-19 12:00:00+00');
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.toISOString()).toBe('2026-05-19T12:00:00.000Z');
    });

    it('round-trips a Date through JSON (how records are stored and sent)', () => {
        const now = new Date();
        const result = TimestampSchema.safeParse(JSON.parse(JSON.stringify({ t: now })).t);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.getTime()).toBe(now.getTime());
    });

    it('REJECTS an epoch number (no producer emits one)', () => {
        expect(TimestampSchema.safeParse(1_700_000_000_000).success).toBe(false);
    });

    it('REJECTS the legacy {seconds, nanoseconds} and {toDate} object forms', () => {
        expect(TimestampSchema.safeParse({ seconds: 1_700_000_000, nanoseconds: 0 }).success).toBe(false);
        expect(
            TimestampSchema.safeParse({ toDate: () => new Date('2026-05-19T12:00:00.000Z') }).success,
        ).toBe(false);
    });

    it('REJECTS an empty string (would coerce to Invalid Date)', () => {
        const result = TimestampSchema.safeParse('');
        expect(result.success).toBe(false);
    });

    it('REJECTS a garbage string (would coerce to Invalid Date)', () => {
        const result = TimestampSchema.safeParse('not-a-date');
        expect(result.success).toBe(false);
    });

    it('REJECTS an Invalid Date', () => {
        const result = TimestampSchema.safeParse(new Date(NaN));
        expect(result.success).toBe(false);
    });
});
