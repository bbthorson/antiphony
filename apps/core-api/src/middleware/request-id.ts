import type { MiddlewareHandler } from 'hono';
import { correlationId } from '../lib/logger.js';

/**
 * Request-ID middleware. Reads the inbound `X-Request-ID` header if present
 * (so a caller that already has correlation can propagate it across the
 * origin boundary); otherwise mints a fresh UUID. Stamps the ID on the
 * response and on `c.var.requestId` for handlers and the error middleware.
 *
 * Why propagation rather than always minting: a calling application and
 * core-api are separate deployments on separate origins, so without an
 * inbound header their two log lines are un-linkable records of the same
 * request. This middleware is that correlation seam — a caller that already
 * has a correlation id sends it as `X-Request-ID` on outbound fetches, and
 * both surfaces then agree on one id for the request.
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
