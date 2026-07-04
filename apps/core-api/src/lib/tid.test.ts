import { describe, it, expect } from 'vitest';
import { isValidTid, isValidRecordKey } from '@atproto/syntax';
import { newTid, encodeTid } from './tid.js';

describe('newTid', () => {
    it('mints a 13-char TID that passes the reference validators', () => {
        const tid = newTid();
        expect(tid).toHaveLength(13);
        // The oracle: our hand-rolled encoder must satisfy @atproto/syntax.
        expect(isValidTid(tid)).toBe(true);
        // A TID is also a valid record key (the rkey in the post uri).
        expect(isValidRecordKey(tid)).toBe(true);
    });

    it('is strictly increasing and collision-free across rapid successive mints', () => {
        const tids = Array.from({ length: 1000 }, () => newTid());
        for (let i = 1; i < tids.length; i++) {
            // Strictly greater — monotonic even when many land in the same ms.
            expect(tids[i] > tids[i - 1]).toBe(true);
        }
        expect(new Set(tids).size).toBe(tids.length);
    });

    it('sorts lexicographically in creation order (= time order)', () => {
        const tids = Array.from({ length: 100 }, () => newTid());
        expect([...tids].sort()).toEqual(tids);
    });
});

describe('encodeTid', () => {
    it('is 13 chars and reference-valid for a realistic timestamp', () => {
        const tid = encodeTid(Date.now() * 1000, 7);
        expect(tid).toHaveLength(13);
        expect(isValidTid(tid)).toBe(true);
    });

    it('encodes later timestamps to lexicographically greater TIDs', () => {
        expect(encodeTid(1_000_000, 0) < encodeTid(2_000_000, 0)).toBe(true);
        expect(encodeTid(1_700_000_000_000_000, 0) < encodeTid(1_700_000_000_000_001, 0)).toBe(true);
    });

    it('left-pads short values with the zero digit to the fixed 11+2 layout', () => {
        // timestamp 0, clock 0 → all-'2' padding (still a valid-shape key).
        expect(encodeTid(0, 0)).toBe('2'.repeat(13));
        // timestamp 1 → one '3' in the low position of the 11-char field.
        expect(encodeTid(1, 0)).toBe('2'.repeat(10) + '3' + '22');
    });
});
