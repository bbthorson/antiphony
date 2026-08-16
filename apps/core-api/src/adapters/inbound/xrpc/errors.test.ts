import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { ServiceError } from 'shared/errors';
import { xrpcSymbol, xrpcErrorHandler } from './errors.js';

/**
 * The XRPC error dialect in isolation.
 *
 * `index.test.ts` covers the statuses reachable by driving a route. This file
 * covers the mapping table itself, including the two statuses that are awkward
 * to provoke end-to-end — 429 (needs the rate-limit store to deny) and 409
 * (needs an in-flight idempotent create) — because those are exactly the ones
 * where a wrong symbol would ship unnoticed.
 */

vi.mock('../../../lib/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('shared/observability/report-error', () => ({ reportError: vi.fn() }));

describe('xrpcSymbol', () => {
    it.each([
        [400, 'InvalidRequest'],
        [401, 'AuthenticationRequired'],
        [403, 'Forbidden'],
        [404, 'RecordNotFound'],
        [409, 'Conflict'],
        [429, 'RateLimitExceeded'],
        [500, 'InternalServerError'],
    ])('maps %i to %s', (status, symbol) => {
        expect(xrpcSymbol(status)).toBe(symbol);
    });

    it('falls back to InternalServerError for an unmapped status', () => {
        // 418 is not a status this service raises; the point is that an
        // unmapped one degrades to the 500 symbol rather than to `undefined`,
        // which would serialize as a body with no `error` field at all.
        expect(xrpcSymbol(418)).toBe('InternalServerError');
    });
});

describe('xrpcErrorHandler', () => {
    /** A minimal app whose only job is to throw what the test supplies. */
    function appThatThrows(err: unknown) {
        const app = new Hono();
        app.onError(xrpcErrorHandler);
        app.get('/boom', () => {
            throw err;
        });
        return app;
    }

    it('renders a rate-limit refusal as RateLimitExceeded, preserving the status', async () => {
        const res = await appThatThrows(
            new ServiceError('Too many requests', 429, undefined, 'RATE_LIMITED'),
        ).request('/boom');

        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({
            error: 'RateLimitExceeded',
            message: 'Too many requests',
        });
    });

    it('renders a 409 as Conflict rather than folding it into InvalidRequest', async () => {
        // An idempotency conflict means "your earlier identical request is still
        // in flight" — retry later. `InvalidRequest` would tell the client its
        // payload was wrong, which points at the opposite remedy.
        const res = await appThatThrows(new ServiceError('Request already in progress', 409)).request(
            '/boom',
        );

        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('Conflict');
    });

    it('does not carry the REST envelope fields', async () => {
        const res = await appThatThrows(new ServiceError('nope', 400)).request('/boom');
        const body = await res.json();

        expect(body.success).toBeUndefined();
        expect(body.requestId).toBeUndefined();
        expect(Object.keys(body).sort()).toEqual(['error', 'message']);
    });

    it('reports unknown throws to Error Reporting but not expected client errors', async () => {
        const { reportError } = await import('shared/observability/report-error');

        await appThatThrows(new ServiceError('not found', 404)).request('/boom');
        expect(reportError).not.toHaveBeenCalled();

        await appThatThrows(new Error('kaboom')).request('/boom');
        expect(reportError).toHaveBeenCalledTimes(1);
    });
});
