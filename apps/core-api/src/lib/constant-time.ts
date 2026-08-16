import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison. Hash both sides to fixed-length digests,
 * then compare with the native `crypto.timingSafeEqual` — no timing or length
 * leaks, no hand-rolled loop the JIT could optimize out of constant time.
 *
 * Hashing first is what makes the length-independence work: `timingSafeEqual`
 * THROWS on differing buffer lengths, so feeding it raw secrets would both
 * crash on a wrong-length guess and leak the expected length by doing so.
 *
 * Extracted here because three middlewares now compare a shared secret
 * (service-auth, system-auth) and a security primitive copied per
 * call site is one that drifts.
 */
export function constantTimeEqual(a: string, b: string): boolean {
    const aHash = createHash('sha256').update(a).digest();
    const bHash = createHash('sha256').update(b).digest();
    return timingSafeEqual(aHash, bHash);
}
