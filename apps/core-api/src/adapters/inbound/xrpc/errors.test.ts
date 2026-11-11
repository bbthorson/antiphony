import { describe, it, expect, vi } from 'vitest';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Hono } from 'hono';
import { ServiceError } from 'shared/errors';
import { REPLY_CID_MISMATCH } from '@antiphony/core/services/audio-posts';
import * as remotePosts from '@antiphony/core/services/remote-posts';
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
        [410, 'Gone'],
        [413, 'PayloadTooLarge'],
        [503, 'ServiceUnavailable'],
    ])('maps %i to %s', (status, symbol) => {
        expect(xrpcSymbol(status)).toBe(symbol);
    });

    it.each([418, 422, 451])('falls back to InvalidRequest for an unmapped client error (%i)', (status) => {
        // A client error the table doesn't list is still the client's to fix.
        // It used to fall through to InternalServerError, which tells a client
        // the fault is the server's; 422 is the one the remote-post methods
        // raise (`REMOTE_RECORD_INVALID`, when no named error applies).
        expect(xrpcSymbol(status)).toBe('InvalidRequest');
    });

    it.each([502, 504, 599, 302])('falls back to InternalServerError for any other unmapped status (%i)', (status) => {
        // Never `undefined`, which would serialize as a body with no `error`
        // field at all.
        expect(xrpcSymbol(status)).toBe('InternalServerError');
    });

    it('names the errors a lexicon declares, by domain code', () => {
        expect(xrpcSymbol(400, 'REPLY_CID_MISMATCH')).toBe('ReplyCidMismatch');
        // Any other code keeps its status's generic symbol.
        expect(xrpcSymbol(400, 'VALIDATION_ERROR')).toBe('InvalidRequest');
    });

    it.each([
        [400, 'REMOTE_URI_UNSUPPORTED', 'RemoteUriUnsupported'],
        [400, 'REMOTE_REQUEST_INVALID', 'RemoteRequestInvalid'],
        [403, 'REMOTE_DELEGATION_REFUSED', 'RemoteDelegationRefused'],
        [404, 'REMOTE_RECORD_NOT_FOUND', 'RemoteRecordNotFound'],
        [503, 'REMOTE_REPO_UNREACHABLE', 'RemoteRepoUnreachable'],
        [409, 'REMOTE_CID_MISMATCH', 'RemoteCidMismatch'],
        [422, 'REMOTE_RECORD_INVALID', 'RemoteRecordInvalid'],
        [409, 'REMOTE_BLOB_SPACE_MISMATCH', 'RemoteBlobSpaceMismatch'],
        [404, 'REMOTE_POST_NOT_FOUND', 'RemotePostNotFound'],
        [410, 'REMOTE_POST_DELETED', 'RemotePostDeleted'],
    ])('names the remote-post refusal %i %s as %s', (status, code, symbol) => {
        expect(xrpcSymbol(status, code)).toBe(symbol);
    });
});

describe('the named errors the lexicons declare', () => {
    const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
    /** Symbols that come from a status rather than a domain code. */
    const BY_STATUS = new Set([400, 401, 403, 404, 409, 410, 413, 429, 500, 503].map((s) => xrpcSymbol(s)));
    /** Every domain code a lexicon names an error for. */
    const CODES = [
        REPLY_CID_MISMATCH,
        remotePosts.INVALID_CURSOR,
        remotePosts.REMOTE_URI_UNSUPPORTED,
        remotePosts.REMOTE_REQUEST_INVALID,
        remotePosts.REMOTE_DELEGATION_REFUSED,
        remotePosts.REMOTE_RECORD_NOT_FOUND,
        remotePosts.REMOTE_REPO_UNREACHABLE,
        remotePosts.REMOTE_CID_MISMATCH,
        remotePosts.REMOTE_RECORD_INVALID,
        remotePosts.REMOTE_BLOB_SPACE_MISMATCH,
        remotePosts.REMOTE_POST_NOT_FOUND,
        remotePosts.REMOTE_POST_DELETED,
    ];

    it('are each produced from a domain code, so a declared name is one a client can actually receive', () => {
        const produced = new Set(CODES.map((code) => xrpcSymbol(400, code)));
        const declared = globSync('lexicons/dev/antiphony/**/*.json', { cwd: REPO_ROOT }).flatMap((file) => {
            const doc = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8')) as {
                defs: Record<string, { errors?: Array<{ name: string }> }>;
            };
            return Object.values(doc.defs).flatMap((def) => (def.errors ?? []).map((e) => e.name));
        });
        expect(declared.length).toBeGreaterThan(10);
        expect([...new Set(declared)].filter((name) => !BY_STATUS.has(name) && !produced.has(name))).toEqual([]);
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

    it('renders a 422 with no named error as InvalidRequest, preserving the status', async () => {
        const res = await appThatThrows(new ServiceError('not an audio post', 422)).request('/boom');

        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({ error: 'InvalidRequest', message: 'not an audio post' });
    });

    it('renders a named 503 by its name, and an unnamed one as ServiceUnavailable', async () => {
        const named = await appThatThrows(
            new ServiceError('repo down', 503, { reason: 'timeout' }, 'REMOTE_REPO_UNREACHABLE'),
        ).request('/boom');
        expect(named.status).toBe(503);
        expect((await named.json()).error).toBe('RemoteRepoUnreachable');

        const unnamed = await appThatThrows(new ServiceError('Tenant temporarily unavailable', 503)).request('/boom');
        expect(unnamed.status).toBe(503);
        expect((await unnamed.json()).error).toBe('ServiceUnavailable');
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
