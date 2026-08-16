import { logger } from '../../../lib/logger.js';
import type {
    RateLimitOutcome,
    RateLimitStore,
    RateLimitWindow,
} from '../../../ports/rate-limit-store.js';

/**
 * `rate_limits` as a Durable Object — the destination the Postgres table was a
 * bridge to.
 *
 * ## Why this table and no other
 *
 * It is the one place Postgres is actively the wrong tool. Every other table
 * here is a record store; this is a **high-frequency counter write sitting on
 * the READ path**, so putting it behind a network hop to a single-region
 * database is the worst available shape — every rate-limited request pays a
 * round trip to Virginia before the handler starts, and § Geography in the
 * migration spec is about how expensive that is from the edge.
 *
 * Per-key strongly-consistent counters are precisely what Durable Objects are
 * for. `idFromName(key)` gives one object per bucket, and Cloudflare routes
 * every request for that key to it.
 *
 * This became a purely internal decision in #83. The constraint that used to
 * shape it was that `POST /api/v1/system/rate-limit/check` let a sibling BFF
 * share these exact buckets over HTTP, and a native binding is per-Worker — so
 * the store had to stay queryable. Vox Pop's BFF serves its own check endpoint
 * now and nothing external shares them.
 *
 * ## Atomicity comes free, and that is the real win
 *
 * The port requires reporting and incrementing to be ONE operation, or two
 * concurrent requests both read an under-limit count and both proceed. Each
 * binding has had to earn that differently:
 *
 *   - **Firestore** — a transaction, plus a whole contention branch, because a
 *     read-then-write has an interleaving window. Per-bucket contention had to
 *     be folded into `over` rather than `unavailable`, or a caller hammering
 *     one bucket could trip the circuit breaker and fail-open the limiter for
 *     everybody.
 *   - **Postgres** — one upsert. The interleaving window closes, and the
 *     contention branch stops existing.
 *   - **Here** — nothing at all. A Durable Object serializes requests to one
 *     object by construction (input gating), so the handler below is ordinary
 *     sequential code and cannot race itself.
 *
 * ## State lives in memory, backed by storage
 *
 * Read once at construction under `blockConcurrencyWhile`, so no request is
 * served against an unpopulated counter, then written through on each hit. The
 * write is local to the object rather than a network round trip.
 *
 * Persisting at all is a deliberate call rather than the obvious one. An
 * in-memory-only counter is a common pattern for this, and its failure mode is
 * narrow: an object is evicted only after inactivity, and an inactive bucket's
 * window has usually closed anyway, so resetting it is close to correct. But
 * "close to correct" for a limiter means occasionally granting a full extra
 * window to whoever is hammering hardest — and the object that gets evicted is
 * not necessarily the busy one, since eviction is not per-key fair. A local
 * storage write is cheap enough that the argument for skipping it is weak.
 */

// --- The runtime types this file needs, declared structurally ---------------
//
// Same reasoning as `adapters/outbound/r2/bucket.ts`: importing
// `@cloudflare/workers-types` would put another runtime's `Request`/`Response`
// globals into scope everywhere. The real objects satisfy these.

export interface DurableObjectStorageLike {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
}

export interface DurableObjectStateLike {
    storage: DurableObjectStorageLike;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface DurableObjectStubLike {
    fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
    idFromName(name: string): unknown;
    get(id: unknown): DurableObjectStubLike;
}

/** One bucket's state. `resetAt` is epoch millis. */
interface Bucket {
    count: number;
    resetAt: number;
}

const BUCKET_KEY = 'bucket';

/**
 * The Durable Object class. Exported from `worker.ts` and named in
 * `wrangler.jsonc`'s `durable_objects` + `migrations` blocks — a class is only
 * addressable once a migration has declared it.
 */
export class RateLimiter {
    private bucket: Bucket | undefined;

    constructor(private readonly state: DurableObjectStateLike) {
        // Gates every request until the counter is loaded. Without it the first
        // request after a cold start would decide against an empty bucket and
        // then overwrite the real one.
        void this.state.blockConcurrencyWhile(async () => {
            this.bucket = await this.state.storage.get<Bucket>(BUCKET_KEY);
        });
    }

    async fetch(request: Request): Promise<Response> {
        const window = (await request.json()) as RateLimitWindow;
        const now = Date.now();

        // A closed window RESETS rather than accumulating, which is the port's
        // documented behaviour and the reason a key never needs explicit
        // clearing — and the reason a Durable Object needs no equivalent of the
        // TTL sweep the Postgres table does.
        const bucket =
            this.bucket && this.bucket.resetAt > now
                ? { count: this.bucket.count + 1, resetAt: this.bucket.resetAt }
                : { count: 1, resetAt: now + window.windowMs };

        this.bucket = bucket;
        await this.state.storage.put(BUCKET_KEY, bucket);

        // `>` on a post-increment count: the request that takes the bucket TO
        // the limit is the last one allowed, and the next is refused. Same
        // comparison as the Postgres binding, for the same reason — `>=` here
        // would refuse at limit-1.
        return Response.json({ over: bucket.count > window.limit, count: bucket.count });
    }
}

/**
 * `RateLimitStore` over the Durable Object namespace.
 *
 * The URL is a formality — a Durable Object stub's `fetch` needs a well-formed
 * URL and never resolves it, because the request is delivered to the object
 * rather than routed. Nothing DNS-resolves `rate-limit.invalid`, and using a
 * `.invalid` host makes that explicit rather than leaving a plausible-looking
 * hostname for someone to wonder about.
 */
export function durableObjectRateLimitStore(
    namespace: DurableObjectNamespaceLike,
): RateLimitStore {
    return {
        async hit(key: string, window: RateLimitWindow): Promise<RateLimitOutcome> {
            try {
                const stub = namespace.get(namespace.idFromName(key));
                const res = await stub.fetch('https://rate-limit.invalid/hit', {
                    method: 'POST',
                    body: JSON.stringify(window),
                });
                if (!res.ok) {
                    logger.error({ key, status: res.status }, '[rate-limit] durable object error');
                    return 'unavailable';
                }
                const { over } = (await res.json()) as { over: boolean };
                return over ? 'over' : 'under';
            } catch (error) {
                // Everything reaching here is systemic. There is no contention
                // branch to distinguish — input gating means a bucket cannot
                // contend with itself — so `unavailable` is unambiguous, and
                // the caller's circuit breaker fails open on it.
                logger.error({ error, key }, '[rate-limit] durable object unreachable');
                return 'unavailable';
            }
        },
    };
}
