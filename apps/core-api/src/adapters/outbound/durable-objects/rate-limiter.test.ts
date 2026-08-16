import { describe, it, expect, vi } from 'vitest';
import {
    RateLimiter,
    durableObjectRateLimitStore,
    type DurableObjectStateLike,
} from './rate-limiter.js';

/**
 * The Durable Object rate-limit bucket.
 *
 * Two things are worth pinning, and they are the two that differ between the
 * three bindings that have implemented this port:
 *
 *   - **The counting boundary.** `count > limit` on a post-increment count, so
 *     the request that takes the bucket TO the limit is the last one allowed.
 *     Off by one in either direction is invisible until someone is either
 *     refused a request they paid for or granted one they should not have been.
 *   - **The failure classification.** `unavailable` feeds the caller's circuit
 *     breaker and fails OPEN; `over` fails closed. The Firestore binding had to
 *     fold per-bucket contention into `over` so a caller hammering one bucket
 *     could not trip the breaker for everybody. That branch does not exist
 *     here — input gating means a bucket cannot contend with itself — so
 *     everything reaching the catch is genuinely systemic.
 */

process.env.LOG_LEVEL = 'silent';

const WINDOW = { limit: 3, windowMs: 60_000 };

/** An in-memory stand-in for the object's own storage. */
function fakeState(): DurableObjectStateLike & { store: Map<string, unknown> } {
    const store = new Map<string, unknown>();
    return {
        store,
        storage: {
            get: async <T>(key: string) => store.get(key) as T | undefined,
            put: async <T>(key: string, value: T) => void store.set(key, value),
        },
        blockConcurrencyWhile: async <T>(cb: () => Promise<T>) => cb(),
    };
}

const hit = (limiter: RateLimiter) =>
    limiter.fetch(
        new Request('https://rate-limit.invalid/hit', {
            method: 'POST',
            body: JSON.stringify(WINDOW),
        }),
    );

async function counts(limiter: RateLimiter, times: number) {
    const seen: { over: boolean; count: number }[] = [];
    for (let i = 0; i < times; i++) seen.push(await (await hit(limiter)).json());
    return seen;
}

describe('RateLimiter — counting', () => {
    it('allows exactly `limit` requests, then refuses', async () => {
        const seen = await counts(new RateLimiter(fakeState()), 5);

        expect(seen.map((s) => s.count)).toEqual([1, 2, 3, 4, 5]);
        // The boundary: the third request takes the bucket to the limit and is
        // allowed; the fourth is not.
        expect(seen.map((s) => s.over)).toEqual([false, false, false, true, true]);
    });

    it('resets rather than accumulating once the window closes', async () => {
        // The port's documented behaviour, and the reason a key never needs
        // explicit clearing — and the reason this binding needs no equivalent
        // of the TTL sweep the Postgres table does.
        const state = fakeState();
        const limiter = new RateLimiter(state);
        await counts(limiter, 4);

        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
        try {
            const [after] = await counts(limiter, 1);
            expect(after).toEqual({ over: false, count: 1 });
        } finally {
            clock.mockRestore();
        }
    });

    it('keeps the original reset time while the window is open', async () => {
        // A sliding window would let a steady caller never reset. The window
        // starts on the first hit of a bucket and does not move.
        const state = fakeState();
        const limiter = new RateLimiter(state);
        await counts(limiter, 1);
        const first = state.store.get('bucket') as { resetAt: number };

        await counts(limiter, 2);
        expect((state.store.get('bucket') as { resetAt: number }).resetAt).toBe(first.resetAt);
    });

    it('survives eviction by reloading its counter from storage', async () => {
        // A fresh instance over the same storage is what an evicted-then-woken
        // object looks like. Without the constructor load it would decide
        // against an empty bucket and grant a whole extra window.
        const state = fakeState();
        await counts(new RateLimiter(state), 3);

        const [next] = await counts(new RateLimiter(state), 1);
        expect(next).toEqual({ over: true, count: 4 });
    });
});

describe('durableObjectRateLimitStore', () => {
    /** A namespace whose stub answers with `body`, recording the key routed to. */
    function fakeNamespace(body: unknown, ok = true) {
        const names: string[] = [];
        return {
            names,
            namespace: {
                idFromName: (name: string) => {
                    names.push(name);
                    return { name };
                },
                get: () => ({
                    fetch: async () =>
                        ok
                            ? Response.json(body)
                            : new Response('boom', { status: 500 }),
                }),
            },
        };
    }

    it('routes each bucket key to its own object', async () => {
        // `idFromName` is the whole mechanism: one object per key, and
        // Cloudflare routes every request for that key to it. Hashing keys
        // together would silently share buckets between callers.
        const { names, namespace } = fakeNamespace({ over: false, count: 1 });
        const store = durableObjectRateLimitStore(namespace);

        await store.hit('ratelimit_1.2.3.4', WINDOW);
        await store.hit('ratelimit_5.6.7.8', WINDOW);

        expect(names).toEqual(['ratelimit_1.2.3.4', 'ratelimit_5.6.7.8']);
    });

    it('maps the object answer onto the port outcome', async () => {
        const under = durableObjectRateLimitStore(fakeNamespace({ over: false }).namespace);
        const over = durableObjectRateLimitStore(fakeNamespace({ over: true }).namespace);

        await expect(under.hit('k', WINDOW)).resolves.toBe('under');
        await expect(over.hit('k', WINDOW)).resolves.toBe('over');
    });

    it('reports a non-2xx as unavailable, so the breaker can fail open', async () => {
        const store = durableObjectRateLimitStore(fakeNamespace({}, false).namespace);
        await expect(store.hit('k', WINDOW)).resolves.toBe('unavailable');
    });

    it('does not throw when the namespace is unreachable', async () => {
        // The port is explicit: an unreachable store must return
        // `unavailable`, never throw. Throwing would make the caller's most
        // important branch a catch, and a storage outage would take the whole
        // API down instead of degrading rate limiting.
        const store = durableObjectRateLimitStore({
            idFromName: () => ({}),
            get: () => ({
                fetch: async () => {
                    throw new Error('no route to object');
                },
            }),
        });

        await expect(store.hit('k', WINDOW)).resolves.toBe('unavailable');
    });
});
