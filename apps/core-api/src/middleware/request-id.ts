import type { MiddlewareHandler } from 'hono';
import { correlationId } from '../lib/logger.js';

/**
 * Request-ID middleware. Reads the inbound `X-Request-ID` header if present
 * (so a caller that already has correlation can propagate it across the
 * origin boundary); otherwise mints a fresh UUID. Stamps the ID on the
 * response and on `c.var.requestId` for handlers and the error middleware.
 *
 * Context:
 *   - Phase 4a puts apps/web's RSC fetches on a different origin from core-api.
 *     Without header propagation, the RSC log line and the core-api log line
 *     are two un-linkable requests. This middleware is the correlation seam.
 *   - The existing apps/web `withErrorHandler` mints its own request ID
 *     per request. During transition, apps/web's RSC transport should add
 *     `X-Request-ID: <current web-side correlation ID>` on outbound fetches
 *     so the two log surfaces align.
 */

declare module 'hono' {
    interface ContextVariableMap {
        requestId: string;
    }
}

export const requestId = (): MiddlewareHandler => {
    return async (c, next) => {
        const inbound = c.req.header('x-request-id');
        const id = inbound && inbound.trim() ? inbound.trim() : correlationId();
        c.set('requestId', id);
        c.header('X-Request-ID', id);
        await next();
    };
};
