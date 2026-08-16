import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { ServiceError } from 'shared/errors';
import { reportError } from 'shared/observability/report-error';
import { logger } from '../../../lib/logger.js';

/**
 * The XRPC error dialect.
 *
 * AT Protocol specifies a flat error body — `{ error, message }` — where
 * `error` is a short symbol a client can branch on and `message` is prose for a
 * human. That is a different shape from this service's REST envelope
 * (`{ success: false, error: { message }, requestId }`), and the two must not
 * be conflated: an XRPC client parsing `error` as a string would get an object.
 *
 * Both surfaces sit over the same domain services, which raise `ServiceError`.
 * This handler is the XRPC translation of that vocabulary; `middleware/
 * error-handler.ts` is the REST one. Mounted via the sub-app's `onError`, so it
 * also catches throws from shared middleware (auth, rate-limit) on
 * XRPC routes — Hono dispatches those to the mounted app's handler, not the
 * parent's.
 */

/** The XRPC error body. `error` is the symbol; `message` is for humans. */
export interface XrpcErrorBody {
    error: string;
    message: string;
}

/**
 * HTTP status → XRPC error symbol.
 *
 * The first six are the symbols named in specs/xrpc-and-atproto-lex-strategy.md
 * §5.4. `Conflict` (409) is an addition: the spec's list omitted it, but
 * `createPost` returns 409 on an idempotency conflict, and folding that into
 * `InvalidRequest` would tell a client its payload was malformed when the real
 * answer is "your earlier identical request is still in flight" — the one case
 * where retrying later is correct.
 *
 * Anything unmapped becomes `InternalServerError`, matching the 500 fallback.
 */
const SYMBOL_BY_STATUS: Record<number, string> = {
    400: 'InvalidRequest',
    401: 'AuthenticationRequired',
    403: 'Forbidden',
    404: 'RecordNotFound',
    409: 'Conflict',
    429: 'RateLimitExceeded',
    500: 'InternalServerError',
};

/** The XRPC symbol for a domain error's HTTP status. */
export function xrpcSymbol(status: number): string {
    return SYMBOL_BY_STATUS[status] ?? 'InternalServerError';
}

/**
 * Build an XRPC error body. Exported so route handlers can answer with the
 * dialect directly (a missing required parameter, say) without throwing.
 */
export function xrpcError(error: string, message: string): XrpcErrorBody {
    return { error, message };
}

/**
 * `onError` for the XRPC sub-app. Mirrors the REST handler's mapping priority —
 * typed domain errors, then Zod, then malformed JSON, then unknown — but
 * serializes into `{ error, message }`.
 *
 * Log lines carry the same `requestId` the REST surface uses, so one request is
 * traceable across both adapters.
 */
export const xrpcErrorHandler: ErrorHandler = (error, c) => {
    const requestId = c.get('requestId') ?? 'unknown';
    const meta = { requestId, method: c.req.method, url: c.req.path, surface: 'xrpc' };

    // 1. Typed domain errors — including the throws from shared middleware.
    if (error instanceof ServiceError) {
        logger.warn({ ...meta, status: error.status, code: error.code, message: error.message }, 'service error');
        return c.json(
            xrpcError(xrpcSymbol(error.status), error.message),
            error.status as ContentfulStatusCode,
        );
    }

    // 2. Zod throws from `.parse()`. Handlers here use `.safeParse` and shape
    //    their own 400s, so this is the backstop rather than the common path.
    if (error instanceof z.ZodError) {
        logger.warn({ ...meta, issues: error.issues }, 'validation error');
        return c.json(xrpcError('InvalidRequest', 'Payload failed schema validation'), 400);
    }

    // 3. Malformed request body — the client's fault, so 400 not 500.
    if (
        error instanceof SyntaxError ||
        (error instanceof Error && error.message === 'Malformed JSON in request body')
    ) {
        logger.warn({ ...meta, message: error.message }, 'invalid json body');
        return c.json(xrpcError('InvalidRequest', 'Invalid JSON body'), 400);
    }

    // 4. Unknown — never leak internals. Reported to Error Reporting for the
    //    same reason the REST handler reports only this branch: the ones above
    //    are expected client errors, not crashes.
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ ...meta, error: err.message, stack: err.stack }, 'unhandled xrpc error');
    reportError(err, meta);
    return c.json(xrpcError('InternalServerError', 'An unexpected error occurred'), 500);
};
