import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkRateLimit, resetRateLimitCircuitForTest, RATE_LIMITS } from './rate-limit.js';
import type { RateLimitOutcome, RateLimitStore } from '../ports/rate-limit-store.js';

/**
 * Circuit-breaker + fail-open POLICY, exercised against a fake store.
 *
 * This suite exists because the `RateLimitStore` seam made it possible. Before
 * the extraction the policy and the Firestore transaction were one function, so
 * reaching the branches below meant mocking `firebase-admin` and throwing
 * objects shaped like gRPC status errors — which tested the mock's fidelity as
 * much as the policy. Here the store is three lines and each branch is reached
 * by returning a value.
 *
 * `rate-limit.test.ts` still covers the middleware end to end against the
 * Firestore binding; this is the layer below it, and the two do not overlap.
 */

function fakeStore(outcomes: RateLimitOutcome[]): RateLimitStore & { calls: number } {
    let i = 0;
    return {
        calls: 0,
        async hit(): Promise<RateLimitOutcome> {
            this.calls++;
            // Last value repeats, so a test can say "unavailable from now on"
            // without padding the array to the call count.
            return outcomes[Math.min(i++, outcomes.length - 1)];
        },
    };
}

const WINDOW = RATE_LIMITS.read;

describe('rate-limit policy (circuit breaker + fail-open)', () => {
    beforeEach(() => {
        resetRateLimitCircuitForTest();
        vi.useRealTimers();
    });

    it('allows when the store reports under limit', async () => {
        const store = fakeStore(['under']);
        await expect(checkRateLimit('k', WINDOW, undefined, store)).resolves.toEqual({
            allowed: true,
        });
    });

    it('refuses when the store reports over limit', async () => {
        const store = fakeStore(['over']);
        await expect(checkRateLimit('k', WINDOW, undefined, store)).resolves.toEqual({
            allowed: false,
        });
    });

    it('fails OPEN on a single unavailable answer', async () => {
        // One systemic blip must not refuse traffic — the breaker exists so an
        // outage degrades to "no rate limiting", never to "no API".
        const store = fakeStore(['unavailable']);
        await expect(checkRateLimit('k', WINDOW, undefined, store)).resolves.toEqual({
            allowed: true,
        });
    });

    it('opens the circuit after 5 consecutive unavailable answers and stops calling the store', async () => {
        const store = fakeStore(['unavailable']);
        for (let n = 0; n < 5; n++) {
            await checkRateLimit('k', WINDOW, undefined, store);
        }
        expect(store.calls).toBe(5);

        // Sixth call is short-circuited: the point of the breaker is to stop
        // paying for a backend that is not answering, not merely to keep
        // allowing traffic.
        await expect(checkRateLimit('k', WINDOW, undefined, store)).resolves.toEqual({
            allowed: true,
        });
        expect(store.calls).toBe(5);
    });

    it('resets the failure count when the store answers again', async () => {
        const store = fakeStore(['unavailable', 'unavailable', 'unavailable', 'under', 'unavailable']);
        for (let n = 0; n < 4; n++) {
            await checkRateLimit('k', WINDOW, undefined, store);
        }
        // Four failures then a success: the counter is back to zero, so the
        // fifth failure is failure #1 and the breaker stays shut.
        await checkRateLimit('k', WINDOW, undefined, store);
        expect(store.calls).toBe(5);

        // Still calling through — proof the breaker did not latch.
        await checkRateLimit('k', WINDOW, undefined, store);
        expect(store.calls).toBe(6);
    });

    it('does NOT open the circuit when a store reports contention as `over`', async () => {
        // The load-bearing asymmetry. A Firestore binding maps per-bucket
        // transaction contention to `over`, not `unavailable`, precisely so one
        // caller hammering their own bucket cannot trip the breaker and
        // fail-open the limiter for everyone else.
        //
        // Before the port, provoking this meant throwing a fake gRPC ABORTED
        // through a mocked Admin SDK. Now it is the return value.
        const store = fakeStore(['over']);
        for (let n = 0; n < 10; n++) {
            await checkRateLimit('hot-bucket', WINDOW, undefined, store);
        }
        expect(store.calls).toBe(10);

        // Breaker never opened, so a DIFFERENT bucket is still being enforced —
        // the property that would silently break if contention were classified
        // as a systemic failure.
        const other = fakeStore(['over']);
        await expect(checkRateLimit('other', WINDOW, undefined, other)).resolves.toEqual({
            allowed: false,
        });
    });
});
