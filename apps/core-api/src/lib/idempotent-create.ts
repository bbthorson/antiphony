import type { Context } from 'hono';
import {
    checkIdempotency,
    saveIdempotencyResult,
    releaseIdempotencyClaim,
    IdempotencyInProgressError,
} from './idempotency.js';

/**
 * The claim / work / settle-or-release sequence of an `Idempotency-Key` create,
 * written once for the two surfaces that have one (REST `POST /api/v1/posts`
 * and XRPC `dev.antiphony.audio.createPost`).
 *
 * The sequence is the part that must not drift between them: a claim left held
 * after a refused request locks a corrected retry out for 24 hours, and a
 * result saved for a request that created nothing replays a failure as success.
 * What differs is the response dialect, so the caller supplies how to answer a
 * replay and an in-flight duplicate, and `work` builds its own responses.
 *
 * `work` reports whether a record was created:
 *   - `created: true`  — the key is settled with `body`, the response to replay.
 *   - `created: false` — validation or a pre-flight refusal; the claim is
 *                        released so the same key can be retried corrected.
 *   - a throw          — also released, and rethrown for the surface's error
 *                        handler to render.
 *
 * With no header, claim, save and release are all no-ops (see `idempotency.ts`),
 * so a request without a key runs `work` and nothing else.
 */
export type IdempotentOutcome<R> =
    | { created: true; body: unknown; response: R }
    | { created: false; response: R };

export interface IdempotentResponders<R> {
    /** Answer a retry with the response stored for its key. */
    replay(body: unknown): R;
    /** Answer a duplicate that arrived while the first is still running. */
    inFlight(): R;
}

export async function runIdempotent<R>(
    c: Context,
    uid: string,
    scope: string | undefined,
    responders: IdempotentResponders<R>,
    work: () => Promise<IdempotentOutcome<R>>,
): Promise<R> {
    try {
        const idem = await checkIdempotency(c, uid, undefined, scope);
        if (idem) return responders.replay(idem.cached);
    } catch (err) {
        if (err instanceof IdempotencyInProgressError) return responders.inFlight();
        throw err;
    }

    let outcome: IdempotentOutcome<R>;
    try {
        outcome = await work();
    } catch (err) {
        await releaseIdempotencyClaim(c, uid, undefined, scope);
        throw err;
    }

    if (outcome.created) {
        await saveIdempotencyResult(c, uid, outcome.body, undefined, scope);
    } else {
        await releaseIdempotencyClaim(c, uid, undefined, scope);
    }
    return outcome.response;
}
