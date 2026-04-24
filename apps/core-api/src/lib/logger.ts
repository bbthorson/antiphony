import { pino } from 'pino';
import { randomUUID } from 'node:crypto';

/**
 * pino logger for core-api. Emits single-line JSON to stdout; Cloud Logging
 * parses JSON fields natively into the LogEntry payload, so structured
 * fields end up queryable without any custom transport.
 *
 * Why pino over Winston (which apps/web uses): pino is faster, JSON-first,
 * and has no ceremony around child loggers with bound context. Apps/web's
 * Winston setup is the legacy choice for that codebase; see
 * specs/decoupling-migration.md Post-4a Follow-ups for the "migrate
 * apps/web to pino" note.
 *
 * Log level comes from `LOG_LEVEL` env (default: `info` in prod, `debug`
 * otherwise). Set `LOG_LEVEL=silent` in tests to suppress output.
 */

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    // In dev, pretty-print if available; fall back to JSON if pino-pretty isn't installed.
    ...(isProduction
        ? {}
        : {
              // pino-pretty is optional — import path kept so it's a no-op if absent.
              // We avoid the dep in prod since it bloats cold start.
          }),
    base: {
        service: 'core-api',
    },
});

/**
 * Generate a request correlation ID. Used by the request-id middleware to
 * stamp each request and by `withErrorHandler` to surface the same ID in
 * error responses for support correlation.
 */
export function correlationId(): string {
    return randomUUID();
}

/** Build a request-scoped child logger with the correlation ID pre-bound. */
export function childLogger(requestId: string, extra: Record<string, unknown> = {}) {
    return logger.child({ requestId, ...extra });
}

export type Logger = typeof logger;
