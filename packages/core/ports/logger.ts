/**
 * Minimal structured-logger interface for packages/core services.
 *
 * Pino (apps/core-api) satisfies this natively. The `defaultLogger` below
 * wraps console so service singletons that don't receive an injected logger
 * (e.g. `rssService`) still emit output rather than silently dropping logs.
 *
 * Call convention mirrors pino:
 *   logger.info({ key: val }, 'message')   — structured context + message
 *   logger.error('message')                — plain string
 */
export interface Logger {
    info(obj: object, msg: string): void;
    info(msg: string): void;
    warn(obj: object, msg: string): void;
    warn(msg: string): void;
    error(obj: object, msg: string): void;
    error(msg: string): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const defaultLogger: Logger = console as unknown as Logger;
