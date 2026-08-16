/**
 * The slice of the Workers runtime's own types that `worker.ts` needs.
 *
 * Declared structurally rather than by importing `@cloudflare/workers-types`,
 * for exactly the reasons `adapters/outbound/r2/bucket.ts` gives for doing the
 * same with `R2Bucket`: core-api still builds and runs as a Node service, and
 * pulling the full Workers ambient package in would put another runtime's
 * `Request`/`Response`/`fetch` globals into scope in every file — a real source
 * of "compiles, then behaves differently" now that the two runtimes coexist.
 *
 * The runtime's real objects satisfy these structurally, so `export default`
 * needs no cast.
 */

/**
 * Per-invocation context. `waitUntil` extends the invocation past the response.
 *
 * `props` carries the values a Worker was invoked with through a service
 * binding or Workers RPC. Nothing here reads it, but Hono's own
 * `ExecutionContext` requires it, and this type is handed straight to
 * `app.fetch` — so omitting it would force a cast at the one call site that
 * exists to avoid one.
 */
export interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
    props: unknown;
}

/** The Cron Trigger that fired, as passed to `scheduled`. */
export interface ScheduledController {
    /** Epoch millis the trigger was scheduled for. */
    scheduledTime: number;
    /** The cron expression that matched, verbatim from wrangler config. */
    cron: string;
}

/**
 * One queue message, as delivered to a `queue` handler.
 *
 * `ack()` and `retry()` are per-message rather than per-batch, which is what
 * lets one poisoned payload be dropped without dragging its batch-mates back
 * through the queue with it.
 */
export interface Message<T> {
    id: string;
    body: T;
    /** Settle this message as done. Not redelivered. */
    ack(): void;
    /** Hand this message back for redelivery, subject to `max_retries`. */
    retry(): void;
}

export interface MessageBatch<T> {
    queue: string;
    messages: readonly Message<T>[];
    retryAll(): void;
}

/**
 * A Worker's module-syntax entry object.
 *
 * `env` is `unknown` rather than a binding interface on purpose. The bindings
 * are read in exactly one place — `readRuntimeEnv` in `composition.ts` — which
 * normalises a Worker's binding objects and Node's `process.env` strings into
 * the same shape. Typing them here would put a second, Worker-only description
 * of the environment next to that one, and the two would drift.
 */
export interface ExportedHandler<QueueMessage = unknown> {
    fetch?(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>;
    scheduled?(
        controller: ScheduledController,
        env: unknown,
        ctx: ExecutionContext,
    ): Promise<void>;
    queue?(
        batch: MessageBatch<QueueMessage>,
        env: unknown,
        ctx: ExecutionContext,
    ): Promise<void>;
}
