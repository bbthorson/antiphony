/**
 * The Workers AI binding (`env.AI`), made reachable from the provider registry.
 *
 * Provider availability in `lib/provider-registry.ts` is answered with no
 * arguments — `available()` reads the environment — and every other provider
 * is configured by a var or secret that Workers copies into `process.env`. A
 * binding has no `process.env` form: it only ever arrives as a handler's
 * `env`. So `worker.ts` hands it over here at the top of `fetch`, `scheduled`
 * and `queue`, and the registry reads it back with `workersAi()`.
 *
 * Under the Node entry (`index.ts`) nothing calls `bindWorkersAi`, so the
 * `workers-ai` provider reports unavailable and the default scan moves on —
 * the same honest-absence path an unset API key takes.
 */

/** The one method the adapters call, typed structurally (no workers-types import). */
export interface WorkersAiBinding {
    run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

let binding: WorkersAiBinding | undefined;

/** Called by `worker.ts` with each handler's `env`. Idempotent. */
export function bindWorkersAi(env: unknown): void {
    const ai = typeof env === 'object' && env !== null && 'AI' in env ? env.AI : undefined;
    if (isWorkersAiBinding(ai)) binding = ai;
}

function isWorkersAiBinding(x: unknown): x is WorkersAiBinding {
    return typeof x === 'object' && x !== null && 'run' in x && typeof x.run === 'function';
}

export function workersAi(): WorkersAiBinding | undefined {
    return binding;
}

/** Test seam: install a fake binding, or clear it with `undefined`. */
export function setWorkersAiForTest(ai: WorkersAiBinding | undefined): void {
    binding = ai;
}
