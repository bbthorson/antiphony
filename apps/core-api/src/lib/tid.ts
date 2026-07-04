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
// counter keeps successive TIDs strictly increasing within a single millisecond,
// and max(now, last) stops them from moving backwards if the wall clock does.
let lastMillis = 0;
let subMillisCount = 0;
// The clock id is drawn once per process; two processes minting in the very
// same microsecond only collide when they also happened to draw the same id.
const CLOCK_ID = Math.floor(Math.random() * 32);

/**
 * Mint the next TID for this process: monotonic, time-sortable, 13 chars.
 * Validated against the reference syntax before returning, so a malformed key
 * (e.g. a far-future timestamp that overflows the field) fails loud at mint
 * time rather than becoming a bad `at://` authority downstream.
 */
export function newTid(): string {
    const now = Math.max(Date.now(), lastMillis);
    subMillisCount = now === lastMillis ? subMillisCount + 1 : 0;
    lastMillis = now;
    const tid = encodeTid(now * 1000 + subMillisCount, CLOCK_ID);
    ensureValidTid(tid);
    return tid;
}
