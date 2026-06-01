import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { ServiceError } from 'shared/errors';
import { logger } from '../lib/logger.js';
import { errorEnvelope } from '../lib/error-envelope.js';

/**
 * Hono error handler. Equivalent of `apps/web/src/lib/api/withErrorHandler.ts`,
 * rewritten for Hono's `app.onError` signature.
 *
 * Error mapping priority:
 *   1. `ServiceError` subclasses — typed domain errors with HTTP status.
 *      Preferred pattern; routes and services throw these directly.
 *   2. `z.ZodError` — uncaught Zod validation throws. Routes that use
 *      `.safeParse` and shape their own 400 responses don't hit this path;
 *      this exists for `.parse()` calls that throw through.
 *   3. Unknown — anything else becomes a 500. Stack details hidden in
 *      production to avoid leaking internals.
 *
 * Every response includes the `requestId` correlation ID (set by the
 * request-id middleware) so support can trace a single request across
 * core-api, apps/web, and any downstream Cloud Functions logs.
 *
 * Response shape (Phase 4 of envelope standardization — symmetric with the
 * success envelope):
 *   { success: false, error: { message, code? }, requestId, ... }
 */

export const errorHandler: ErrorHandler = (error, c) => {
    // requestId is guaranteed by the request-id middleware (installed first).
    // Fallback covers the edge case where error fires before that middleware
    // ran (shouldn't happen but keeps the handler total).
    const requestId = c.get('requestId') ?? 'unknown';
    const meta = {
        requestId,
        method: c.req.method,
        url: c.req.path,
    };

    // 1. Typed service errors — the preferred pattern.
    if (error instanceof ServiceError) {
        logger.warn({ ...meta, status: error.status, code: error.code, message: error.message }, 'service error');
        return c.json(
            errorEnvelope(c, error.message, {
                ...(error.code !== undefined ? { code: error.code } : {}),
                ...(error.details !== undefined ? { details: error.details } : {}),
            }),
            // Hono's ContentfulStatusCode is the full set of status codes
            // valid for a JSON response body — covers 400/401/403/404/409/
            // 422/429/500 and anything else ServiceError subclasses carry.
            error.status as ContentfulStatusCode,
        );
    }

    // 2. Zod validation errors (thrown via schema.parse() instead of safeParse).
    if (error instanceof z.ZodError) {
        logger.warn({ ...meta, issues: error.issues }, 'validation error');
        return c.json(
            errorEnvelope(c, 'Validation Error', { issues: error.issues }),
            400,
        );
    }

    // 3. Invalid JSON body. The OpenAPI body validator throws a plain
    //    `Error` with the literal message `"Malformed JSON in request body"`
    //    when `Content-Type: application/json` is set but the body fails
    //    to parse. Native `c.req.json()` throws a `SyntaxError`. Either
    //    way the client sent bad input — 400, not 500.
    if (
        error instanceof SyntaxError ||
        (error instanceof Error && error.message === 'Malformed JSON in request body')
    ) {
        logger.warn({ ...meta, message: error.message }, 'invalid json body');
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    // 4. Unknown errors — never leak internals in production.
    const isDev = process.env.NODE_ENV === 'development';
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ ...meta, error: err.message, stack: err.stack }, 'unhandled api error');
    return c.json(
        errorEnvelope(c, 'Internal Server Error', isDev ? { details: err.message } : {}),
        500,
    );
};
