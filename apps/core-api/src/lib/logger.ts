import type { Logger as LoggerPort } from '@antiphony/core/ports/logger';

/**
 * Structured JSON logger for core-api — one line per record, on `console`.
 *
 * ## Why not pino any more
 *
 * pino resolves platform-specific worker/transport scripts through `require()`
 * at module scope, which is why `esbuild.config.mjs` has always had to keep it
 * `external`. A Worker bundle has no `external` escape hatch: everything the
 * module graph reaches has to bundle, and `apps/core-api/src/app.ts` reaches
 * this file from every route. So pino is not a dependency the Worker can carry.
 *
 * That is the forcing reason, but it is a small loss. What this codebase
 * actually used pino for was "single-line JSON on stdout" — no child loggers,
 * no custom levels, no transports, no serializers (`grep -r 'logger.child'`
 * returns nothing). That is thirty lines of `JSON.stringify`, and it runs
 * unmodified on both runtimes.
 *
 * ## The output shape is deliberately byte-compatible with pino's
 *
 * Same keys, same numeric level values, same `base` field. Cloud Logging
 * queries, log-based metrics, and saved views all index on these names, so a
 * "tidier" schema would silently break dashboards during precisely the
 * migration where logs are the only thing to debug against. `severity` is
 * NOT added for the same reason: it would change how existing entries are
 * bucketed, and that is a separate decision from this one.
 *
 * Cloudflare Workers Logs parses a JSON string line the same way Cloud Logging
 * does, so the format survives the runtime move without a second dialect.
 *
 * Level comes from `LOG_LEVEL` (default `info` in production, `debug`
 * otherwise); `LOG_LEVEL=silent` suppresses everything, which is what the test
 * suites set. Read lazily and cached on the raw value rather than captured at
 * module load — same reasoning as `app-config.ts` and `service-auth.ts`, and
 * on a Worker it is load-bearing: `process.env` is populated from bindings, so
 * a module-load read can run before the value it wants exists.
 */

/** pino's numeric level values, reproduced so the emitted `level` is unchanged. */
const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, silent: Infinity } as const;

type LevelName = keyof typeof LEVELS;

let cachedRaw: string | undefined;
let cachedThreshold: number | undefined;

/**
 * The minimum level this deployment emits. An unrecognised `LOG_LEVEL` falls
 * back to the default rather than silencing the logger: a typo'd level that
 * turned logging off would be indistinguishable from a healthy quiet service,
 * which is the failure mode you notice last and want least.
 */
function threshold(): number {
    const raw = process.env.LOG_LEVEL;
    if (raw === cachedRaw && cachedThreshold !== undefined) return cachedThreshold;
    cachedRaw = raw;
    const named = raw?.trim().toLowerCase() as LevelName | undefined;
    const fallback = process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug;
    cachedThreshold = named && named in LEVELS ? LEVELS[named] : fallback;
    return cachedThreshold;
}

/**
 * Replace `Error` values in the caller's context with something JSON keeps.
 *
 * `JSON.stringify(new Error('boom'))` is `{}` — Error's own properties are not
 * enumerable — so `logger.error({ err }, '...')` emitted a record whose only
 * error-shaped field was the empty object. Every diagnostic this logger existed
 * to carry was being dropped at the last step, and the log line looked complete
 * while saying nothing. It was found the hard way: a transcode failed in
 * production, the record read `"err":{}`, and the R2 status code that would have
 * named the cause was gone.
 *
 * Spreading the error FIRST keeps custom enumerable properties (a `status`, a
 * `code`) that the three explicit fields would otherwise hide.
 */
function withErrors(context: object): object {
    let mapped: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(context)) {
        if (value instanceof Error) {
            mapped ??= { ...(context as Record<string, unknown>) };
            mapped[key] = {
                ...value,
                name: value.name,
                message: value.message,
                stack: value.stack,
            };
        }
    }
    // Untouched when there is no Error to rewrite, so the common path allocates
    // nothing extra.
    return mapped ?? context;
}

function emit(level: LevelName, a: object | string, b?: string): void {
    if (LEVELS[level] < threshold()) return;
    // The port's call convention is pino's: `(obj, msg)` or `(msg)`.
    const context = typeof a === 'string' ? undefined : a;
    const msg = typeof a === 'string' ? a : b;
    // `...context` first so an accidental `level`/`time`/`msg` key in caller
    // context cannot overwrite the record's own fields.
    console.log(
        JSON.stringify({
            ...(context ? withErrors(context) : undefined),
            level: LEVELS[level],
            time: Date.now(),
            service: 'core-api',
            msg,
        }),
    );
}

/**
 * The application logger. Satisfies `@antiphony/core`'s `Logger` port, which is
 * what `AudioProcessingService` and the adapters take.
 */
export const logger = {
    debug: (a: object | string, b?: string) => emit('debug', a, b),
    info: (a: object | string, b?: string) => emit('info', a, b),
    warn: (a: object | string, b?: string) => emit('warn', a, b),
    error: (a: object | string, b?: string) => emit('error', a, b),
} satisfies LoggerPort & { debug: unknown };

/**
 * Generate a request correlation ID. Used by the request-id middleware to
 * stamp each request and by `withErrorHandler` to surface the same ID in
 * error responses for support correlation.
 *
 * `globalThis.crypto` rather than `node:crypto` — it is a global on Workers and
 * on Node 22, so this needs no compat shim on either.
 */
export function correlationId(): string {
    return crypto.randomUUID();
}

export type Logger = typeof logger;
