/**
 * `SqlClient` — the narrowest Postgres surface the bindings need.
 *
 * Deliberately not a driver abstraction. It exists so the Postgres bindings can
 * be exercised against a real Postgres in tests (PGlite, in-process) and a real
 * Postgres in production (Neon) without either being a mock of the other. Both
 * run the same SQL; only the transport differs.
 *
 * ## Why one method
 *
 * Everything the bindings do is a single parameterised statement — that is the
 * whole design of db/schema.sql, where each Firestore transaction collapsed to
 * one upsert or one conditional UPDATE ... RETURNING. There is no interactive
 * transaction left to model, which is also what makes
 * `@neondatabase/serverless` over HTTP viable (its batch-only transaction
 * support would otherwise bind).
 *
 * If a future operation genuinely needs a multi-statement transaction, this is
 * the file that grows a `transaction()` method — and the driver choice has to
 * be revisited at the same time, because the HTTP driver cannot serve it. That
 * coupling is the reason to keep this interface uncomfortably small: widening
 * it should feel like a decision.
 *
 * ## Errors
 *
 * `query` REJECTS on connection or SQL failure. Bindings that must not throw
 * (see ports/rate-limit-store.ts) catch and classify at their own boundary;
 * this layer does not editorialise, because "what does this failure mean" is a
 * question only the caller can answer.
 */
export interface SqlClient {
    /**
     * Run one parameterised statement and return its rows.
     *
     * Placeholders are Postgres-native (`$1`, `$2`, …), not driver-specific.
     * Callers must never interpolate values into `text` — every binding in this
     * codebase passes them through `params`, and a reviewer should treat any
     * template-built SQL here as a defect.
     */
    query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
}
