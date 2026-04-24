import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { ServiceError } from 'shared/errors';
import { logger } from '../lib/logger.js';

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
 * Response shape matches apps/web's contract so clients don't have to
 * branch on origin:
 *   { status: 'error', message: string, requestId: string, ...details }
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
        logger.warn({ ...meta, status: error.status, message: error.message }, 'service error');
        return c.json(
            {
                status: 'error',
                message: error.message,
                requestId,
                ...(error.details ? { details: error.details } : {}),
            },
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
            {
                status: 'error',
                message: 'Validation Error',
                requestId,
                issues: error.issues,
            },
            400,
        );
    }

    // 3. Unknown errors — never leak internals in production.
    const isDev = process.env.NODE_ENV === 'development';
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ ...meta, error: err.message, stack: err.stack }, 'unhandled api error');
    return c.json(
        {
            status: 'error',
            message: 'Internal Server Error',
            requestId,
            ...(isDev ? { details: err.message } : {}),
        },
        500,
    );
};
