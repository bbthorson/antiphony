import { ensureValidTid } from '@atproto/syntax';

/**
 * TID (timestamp identifier) — the AT Protocol record-key format, and the
 * `rkey` in every post uri `at://{appDid}/{collection}/{rkey}`. A TID is 13
 * chars of base32-sortable encoding of a 64-bit value: a 53-bit microsecond
 * timestamp followed by a 10-bit clock id. Because the alphabet sorts in ASCII
 * order and every TID is the same length, record keys sort lexicographically by
 * creation time, and two mints collide only within the same microsecond on the
 * same process's random clock id.
 *
 * We mint TIDs ourselves rather than take `@atproto/common` (which drags in zod
 * + the lexicon codecs) — generation is a ~15-line encoder, and it's the one
 * place `newPostId()` legitimately needs a clock + randomness, which is exactly
 * why it lives behind the port as an adapter method instead of in pure core.
 * Every mint is checked against `@atproto/syntax` (the reference validator) so a
 * spec drift fails loud here rather than becoming a malformed `at://` authority
 * downstream.
 */

// base32-sortable: the ASCII order of these chars matches their numeric value,
// so a big-endian encoding sorts lexicographically by the number it encodes.
const S32_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';

/** Big-endian base32-sortable encoding of a non-negative integer (`0` → ''). */
function s32encode(n: number): string {
    let out = '';
    let i = n;
    while (i > 0) {
        out = S32_ALPHABET[i % 32] + out;
        i = Math.floor(i / 32);
    }
    return out;
}

/**
 * Encode an explicit microsecond timestamp + clock id into a 13-char TID:
 * 11 base32 chars of timestamp + 2 of clock id, left-padded with '2' (the
 * zero digit) to the fixed width. Pure and deterministic — the seam the
 * generator and its tests share.
 */
export function encodeTid(timestampMicros: number, clockId: number): string {
    return s32encode(timestampMicros).padStart(11, '2') + s32encode(clockId).padStart(2, '2');
}

// Per-process monotonic state. Date.now() is millisecond-precision, so a sub-ms
// counter fills the 1000 microseconds each millisecond holds; `lastMillis` is the
// last logical millisecond emitted (a logical clock, not necessarily the wall clock).
let lastMillis = 0;
let subMillisCount = 0;
// The clock id is the TID's low 10 bits, drawn once per process from the full
// 0–1023 range (2 base32 chars hold 1024 values, per the TID spec). Two processes
// minting in the very same microsecond collide only when they also drew the same
// id — 1/1024, not the 1/32 a 5-bit id would give.
const CLOCK_ID = Math.floor(Math.random() * 1024);

/** Microseconds per millisecond — the sub-ms counter's budget before it must roll over. */
const MICROS_PER_MS = 1000;

/**
 * Mint the next TID for this process: monotonic, time-sortable, 13 chars.
 *
 * Because Date.now() is only millisecond-precision, a sub-ms counter enumerates
 * the microseconds within a millisecond. If more than 1000 TIDs are minted in a
 * single wall-clock millisecond the counter would exceed that budget, so we roll
 * the surplus into the next *logical* millisecond and keep the counter in
 * `[0, 999]`. This makes the clock run slightly ahead of the wall clock under
 * sustained load, but it never repeats or moves backwards — which a naive
 * `now*1000 + count` would do once the wall clock caught up to the overflowed
 * microsecond range. `max(now, lastMillis)` likewise absorbs a backwards drift.
 *
 * Validated against the reference syntax before returning, so a malformed key
 * (e.g. a far-future timestamp overflowing the field) fails loud at mint time
 * rather than becoming a bad `at://` authority downstream.
 */
export function newTid(): string {
    const now = Math.max(Date.now(), lastMillis);
    if (now === lastMillis) {
        // Same (or backwards-drifted) millisecond: advance to the next microsecond
        // slot, rolling into the next logical ms once this one's 1000 are spent.
        if (++subMillisCount >= MICROS_PER_MS) {
            lastMillis += 1;
            subMillisCount = 0;
        }
    } else {
        lastMillis = now;
        subMillisCount = 0;
    }
    const tid = encodeTid(lastMillis * MICROS_PER_MS + subMillisCount, CLOCK_ID);
    ensureValidTid(tid);
    return tid;
}

/** Test-only: reset the per-process monotonic clock so a test can drive `Date.now` deterministically. */
export function resetTidClockForTest(): void {
    lastMillis = 0;
    subMillisCount = 0;
}
