import { describe, it, expect, vi, afterEach } from 'vitest';
import { httpRenditionService, renditionServiceConfig } from './http.js';
import type { Logger } from '@antiphony/core/ports/logger';

/**
 * The HTTP binding for the transcode service.
 *
 * Two properties carry the weight. It must never throw — the read path's
 * response is the same for every failure, and a route that had to branch on why
 * would leak the transcode backend's failure modes into a public contract. And
 * it must be BOUNDED, because the consumer is a Twilio `<Play>` fetch on a live
 * call, where waiting is dead air.
 */

const loggerStub = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const CONFIG = { baseUrl: 'https://rendition.test', systemAuthToken: 'sys-tok-abc' };
const REQ = { originAppId: 'vox-pop', cid: 'bafkreiabc', format: 'mp3' as const };

afterEach(() => {
    delete process.env.ANTIPHONY_RENDITION_SERVICE_URL;
    delete process.env.SYSTEM_AUTH_TOKEN;
});

describe('renditionServiceConfig', () => {
    it('reads both values and strips a trailing slash', () => {
        process.env.ANTIPHONY_RENDITION_SERVICE_URL = 'https://rendition.test/';
        process.env.SYSTEM_AUTH_TOKEN = 'sys-tok-abc';

        const resolved = renditionServiceConfig();
        expect(resolved.config).toEqual({
            baseUrl: 'https://rendition.test',
            systemAuthToken: 'sys-tok-abc',
        });
    });

    it('reports BOTH values as missing when neither is set', () => {
        expect(renditionServiceConfig().missing).toEqual([
            'ANTIPHONY_RENDITION_SERVICE_URL',
            'SYSTEM_AUTH_TOKEN',
        ]);
    });

    it('reports a URL with no token as incomplete, not as configured', () => {
        // A URL without a token produces a service call that 401s on every
        // miss — a rendition path that looks configured and never succeeds,
        // which is worse than one plainly off.
        process.env.ANTIPHONY_RENDITION_SERVICE_URL = 'https://rendition.test';

        expect(renditionServiceConfig().config).toBeUndefined();
        expect(renditionServiceConfig().missing).toEqual(['SYSTEM_AUTH_TOKEN']);
    });
});

describe('httpRenditionService', () => {
    it('posts the request with the system bearer', async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

        const ok = await httpRenditionService(CONFIG, loggerStub(), fetchImpl as unknown as typeof fetch).ensure(REQ);

        expect(ok).toBe(true);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://rendition.test/render');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer sys-tok-abc');
        expect(JSON.parse(init.body as string)).toEqual(REQ);
    });

    it('bounds the wait with an abort signal', async () => {
        // The property, not the number. An unbounded wait here would reintroduce
        // exactly the dead-air-on-a-live-call failure this line of work exists
        // to delete, while looking like a feature.
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

        await httpRenditionService(CONFIG, loggerStub(), fetchImpl as unknown as typeof fetch).ensure(REQ);

        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('reports false — not a throw — when the service refuses', async () => {
        const fetchImpl = vi.fn(async () => new Response('nope', { status: 502 }));
        const logger = loggerStub();

        await expect(
            httpRenditionService(CONFIG, logger, fetchImpl as unknown as typeof fetch).ensure(REQ),
        ).resolves.toBe(false);
        expect(logger.error).toHaveBeenCalled();
    });

    it('distinguishes a missing source in the LOG, not in the return', async () => {
        // The caller cannot act differently on it, so the return value is the
        // same. Whoever reads the logs can act on it, so the log line differs.
        const fetchImpl = vi.fn(async () => new Response('no source', { status: 404 }));
        const logger = loggerStub();

        await expect(
            httpRenditionService(CONFIG, logger, fetchImpl as unknown as typeof fetch).ensure(REQ),
        ).resolves.toBe(false);
        expect(logger.warn).toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('reports false when the service is unreachable', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        });

        await expect(
            httpRenditionService(CONFIG, loggerStub(), fetchImpl as unknown as typeof fetch).ensure(REQ),
        ).resolves.toBe(false);
    });

    it('treats a timeout as warn, not error — the transcode is still landing', async () => {
        // Paging on this would page on cold starts. Our budget elapsing does not
        // cancel the transcode, so the next request for the same pair is a cache
        // hit; that is a degrade-once, not a fault.
        const timeout = new Error('The operation was aborted due to timeout');
        timeout.name = 'TimeoutError';
        const fetchImpl = vi.fn(async () => {
            throw timeout;
        });
        const logger = loggerStub();

        await expect(
            httpRenditionService(CONFIG, logger, fetchImpl as unknown as typeof fetch).ensure(REQ),
        ).resolves.toBe(false);
        expect(logger.warn).toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
    });
});
