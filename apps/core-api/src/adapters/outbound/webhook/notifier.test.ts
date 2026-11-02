import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Logger } from '@antiphony/core/ports/logger';
import type { StageSettledEvent } from '@antiphony/core/ports/processing-notifier';
import { webhookNotifier } from './notifier.js';

/**
 * HTTP + HMAC webhook adapter (`specs/enrichment-webhooks.md`, § Auth/Delivery).
 * The transport concerns the service seam does not: signature bytes, the
 * best-effort timeout/retry policy, and the per-tenant silent opt-out. Config is
 * read from env (as in production) and `fetch`/`sleep` are injected so nothing
 * hits the network or a real timer.
 */

const EVENT: StageSettledEvent = {
    originAppId: 'vox-pop',
    postId: 'p1',
    uri: 'at://did:web:voxpop.example/dev.antiphony.audio.post/p1',
    stage: 'transcribe',
    status: 'ready',
    occurredAt: '2026-07-19T14:03:11.204Z',
};

// Must clear webhook-config's ≥32-char floor, or the tenant resolves to no
// config and the notifier correctly sends nothing. The bytes are arbitrary —
// every assertion below recomputes the HMAC from this same constant.
const SECRET = `whsec_test_${'a'.repeat(32)}`;
const URL = 'https://bff.voxpop/hooks';

function loggerStub(): Logger {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/** No-wait sleep so the retry path resolves without wall-clock delay. */
const noSleep = () => Promise.resolve();

function configureTenant() {
    process.env.ANTIPHONY_APP_WEBHOOK_URLS = `vox-pop:${URL}`;
    process.env.ANTIPHONY_APP_WEBHOOK_SECRETS = `vox-pop:${SECRET}`;
}

afterEach(() => {
    delete process.env.ANTIPHONY_APP_WEBHOOK_URLS;
    delete process.env.ANTIPHONY_APP_WEBHOOK_SECRETS;
    vi.restoreAllMocks();
});

describe('webhookNotifier', () => {
    it('POSTs a signed body whose HMAC matches the raw bytes sent', async () => {
        configureTenant();
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

        await webhookNotifier(loggerStub(), fetchImpl as unknown as typeof fetch, noSleep).notify(EVENT);

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(URL);
        expect(init.method).toBe('POST');
        expect(init.redirect).toBe('manual');

        const body = init.body as string;
        const headers = init.headers as Record<string, string>;
        // The signature the receiver would recompute over the exact bytes on the
        // wire must equal the one we sent.
        const expected = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
        expect(headers['X-Antiphony-Signature']).toBe(expected);
        expect(headers['X-Antiphony-Event-Id']).toBe('p1:transcribe:ready');
        expect(headers['X-Antiphony-Timestamp']).toBe(EVENT.occurredAt);
        expect(headers['Content-Type']).toBe('application/json');
        expect(JSON.parse(body)).toEqual({
            type: 'stage.settled',
            postId: 'p1',
            uri: 'at://did:web:voxpop.example/dev.antiphony.audio.post/p1',
            originAppId: 'vox-pop',
            stage: 'transcribe',
            status: 'ready',
            occurredAt: '2026-07-19T14:03:11.204Z',
        });
    });

    it('names a remote post by its URI alone (specs/audio-service-mode.md §6)', async () => {
        configureTenant();
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        const uri = 'at://did:plc:abcdefghijklmnopqrstuvwx/dev.antiphony.audio.post/3kremote00001';
        const { postId: _hosted, ...remote } = EVENT;

        await webhookNotifier(loggerStub(), fetchImpl as unknown as typeof fetch, noSleep).notify({ ...remote, uri });

        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(init.body as string)).not.toHaveProperty('postId');
        expect(JSON.parse(init.body as string)).toMatchObject({ type: 'stage.settled', uri });
        expect((init.headers as Record<string, string>)['X-Antiphony-Event-Id']).toBe(`${uri}:transcribe:ready`);
    });

    it('sends remote.gone and remote.changed through the same signed channel', async () => {
        configureTenant();
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        const notifier = webhookNotifier(loggerStub(), fetchImpl as unknown as typeof fetch, noSleep);
        const uri = 'at://did:plc:abcdefghijklmnopqrstuvwx/dev.antiphony.audio.post/3kremote00001';
        const occurredAt = '2026-11-02T12:00:00.000Z';

        await notifier.notifyRemote({ type: 'remote.changed', originAppId: 'vox-pop', uri, cid: 'bafyreinew', occurredAt });
        await notifier.notifyRemote({ type: 'remote.gone', originAppId: 'vox-pop', uri, occurredAt });

        const sent = fetchImpl.mock.calls.map((c) => c as unknown as [string, RequestInit]);
        expect(JSON.parse(sent[0][1].body as string)).toEqual({
            type: 'remote.changed',
            originAppId: 'vox-pop',
            uri,
            cid: 'bafyreinew',
            occurredAt,
        });
        expect(JSON.parse(sent[1][1].body as string)).toEqual({ type: 'remote.gone', originAppId: 'vox-pop', uri, occurredAt });
        expect((sent[0][1].headers as Record<string, string>)['X-Antiphony-Event-Id']).toBe(`${uri}:remote.changed:bafyreinew`);
        expect((sent[1][1].headers as Record<string, string>)['X-Antiphony-Event-Id']).toBe(`${uri}:remote.gone`);
    });

    it('sends post.deleted through the same signed channel, with its own type and event id', async () => {
        // specs/deletion.md § 8: one URL and secret per tenant, two event types.
        configureTenant();
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        const deleted = {
            originAppId: 'vox-pop',
            postId: 'p1',
            uri: 'at://did:web:voxpop.example/dev.antiphony.audio.post/p1',
            kind: 'prompt' as const,
            occurredAt: '2026-10-20T14:03:11.204Z',
        };

        await webhookNotifier(loggerStub(), fetchImpl as unknown as typeof fetch, noSleep).notifyDeleted(deleted);

        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        const body = init.body as string;
        const headers = init.headers as Record<string, string>;
        expect(headers['X-Antiphony-Signature']).toBe(`sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`);
        expect(headers['X-Antiphony-Event-Id']).toBe('p1:deleted');
        expect(JSON.parse(body)).toEqual({ type: 'post.deleted', ...deleted });
    });

    it('does not POST for a tenant with no webhook configured', async () => {
        // Env deliberately unset → silent opt-out.
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

        await webhookNotifier(loggerStub(), fetchImpl as unknown as typeof fetch, noSleep).notify(EVENT);

        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('retries a 5xx up to the attempt budget, then drops with a log', async () => {
        configureTenant();
        const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
        const logger = loggerStub();

        await webhookNotifier(logger, fetchImpl as unknown as typeof fetch, noSleep).notify(EVENT);

        expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
        expect(logger.error).toHaveBeenCalled();
    });

    it('does not retry a permanent 4xx — the receiver rejected the request itself', async () => {
        configureTenant();
        const fetchImpl = vi.fn(async () => new Response(null, { status: 400 }));
        const logger = loggerStub();

        await webhookNotifier(logger, fetchImpl as unknown as typeof fetch, noSleep).notify(EVENT);

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalled();
    });

    it('retries a transient 429 (rate limited), then succeeds', async () => {
        configureTenant();
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 429 }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));

        await webhookNotifier(loggerStub(), fetchImpl as unknown as typeof fetch, noSleep).notify(EVENT);

        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('retries a transient network error, then succeeds without throwing', async () => {
        configureTenant();
        const fetchImpl = vi
            .fn()
            .mockRejectedValueOnce(new Error('ECONNRESET'))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));

        await expect(
            webhookNotifier(loggerStub(), fetchImpl as unknown as typeof fetch, noSleep).notify(EVENT),
        ).resolves.toBeUndefined();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});
