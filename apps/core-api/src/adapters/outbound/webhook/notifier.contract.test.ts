import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Logger } from '@antiphony/core/ports/logger';
import {
    PostDeletedWebhookSchema,
    RemoteChangedWebhookSchema,
    RemoteGoneWebhookSchema,
    RemoteRecheckRequestedWebhookSchema,
    StageSettledWebhookSchema,
    WEBHOOK_EVENT_ID_HEADER,
    WEBHOOK_SIGNATURE_HEADER,
    WEBHOOK_TIMESTAMP_HEADER,
    WebhookEventSchema,
} from 'shared/types/webhooks';
import { verifyWebhookSignature } from 'shared/utils';
import { webhookNotifier } from './notifier.js';

/**
 * What the notifier puts on the wire is what `@antiphony/shared` tells a
 * receiver to expect. For each of the five event types the body is parsed with
 * the matching published schema and with the union, and the signature is
 * checked with the published verifier, so a sender/schema/verifier mismatch
 * fails here before a tenant finds it.
 */

const SECRET = `whsec_test_${'a'.repeat(32)}`;
const noSleep = () => Promise.resolve();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const AT = '2026-11-12T10:00:00.000Z';
const HOSTED = 'at://did:web:voxpop.example/dev.antiphony.audio.post/p1';
const REMOTE = 'at://did:plc:abcdefghijklmnopqrstuvwx/dev.antiphony.audio.post/3kremote00001';
const SPACE = 'at://did:plc:groupaaaaaaaaaaaaaaaaaaa/space/game.bardcast.space.campaign/thornwood';

afterEach(() => {
    delete process.env.ANTIPHONY_APP_WEBHOOK_URLS;
    delete process.env.ANTIPHONY_APP_WEBHOOK_SECRETS;
});

/** Sends one event through a fresh notifier and returns what reached `fetch`. */
async function capture(send: (n: ReturnType<typeof webhookNotifier>) => Promise<void>) {
    process.env.ANTIPHONY_APP_WEBHOOK_URLS = 'vox-pop:https://bff.voxpop/hooks';
    process.env.ANTIPHONY_APP_WEBHOOK_SECRETS = `vox-pop:${SECRET}`;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await send(webhookNotifier(logger, fetchImpl as unknown as typeof fetch, noSleep));
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    return { body: init.body as string, headers: init.headers as Record<string, string> };
}

const CASES = [
    {
        name: 'stage.settled (hosted)',
        schema: StageSettledWebhookSchema,
        send: (n: ReturnType<typeof webhookNotifier>) =>
            n.notify({ originAppId: 'vox-pop', postId: 'p1', uri: HOSTED, stage: 'transcribe', status: 'ready', occurredAt: AT }),
    },
    {
        name: 'stage.settled (remote, no postId)',
        schema: StageSettledWebhookSchema,
        send: (n: ReturnType<typeof webhookNotifier>) =>
            n.notify({ originAppId: 'vox-pop', uri: REMOTE, stage: 'waveform', status: 'skipped', occurredAt: AT }),
    },
    {
        name: 'post.deleted',
        schema: PostDeletedWebhookSchema,
        send: (n: ReturnType<typeof webhookNotifier>) =>
            n.notifyDeleted({ originAppId: 'vox-pop', postId: 'p1', uri: HOSTED, kind: 'reply', occurredAt: AT }),
    },
    {
        name: 'remote.gone',
        schema: RemoteGoneWebhookSchema,
        send: (n: ReturnType<typeof webhookNotifier>) =>
            n.notifyRemote({ type: 'remote.gone', originAppId: 'vox-pop', uri: REMOTE, occurredAt: AT }),
    },
    {
        name: 'remote.changed',
        schema: RemoteChangedWebhookSchema,
        send: (n: ReturnType<typeof webhookNotifier>) =>
            n.notifyRemote({ type: 'remote.changed', originAppId: 'vox-pop', uri: REMOTE, cid: 'bafyreinew', occurredAt: AT }),
    },
    {
        name: 'remote.recheck_requested',
        schema: RemoteRecheckRequestedWebhookSchema,
        send: (n: ReturnType<typeof webhookNotifier>) =>
            n.notifyRemote({ type: 'remote.recheck_requested', originAppId: 'vox-pop', uri: SPACE, space: SPACE, occurredAt: AT }),
    },
];

describe('the notifier against the published webhook contract', () => {
    it.each(CASES)('$name: the body parses with its schema and the union, and nothing is dropped', async ({ schema, send }) => {
        const { body } = await capture(send);
        const json = JSON.parse(body);
        // A strict comparison: the schemas ignore unknown keys, so equality is
        // what proves the sender added no field the schema does not describe.
        expect(schema.parse(json)).toEqual(json);
        expect(WebhookEventSchema.parse(json)).toEqual(json);
    });

    it.each(CASES)('$name: the published verifier accepts the signature sent, and rejects tampering', async ({ send }) => {
        const { body, headers } = await capture(send);
        const signatureHeader = headers[WEBHOOK_SIGNATURE_HEADER];
        expect(await verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader })).toBe(true);
        expect(await verifyWebhookSignature({ secret: SECRET, rawBody: new TextEncoder().encode(body), signatureHeader })).toBe(true);
        expect(await verifyWebhookSignature({ secret: SECRET, rawBody: body.replace('vox-pop', 'vox-pap'), signatureHeader })).toBe(false);
        expect(await verifyWebhookSignature({ secret: `${SECRET}x`, rawBody: body, signatureHeader })).toBe(false);
    });

    it.each(CASES)('$name: sends the timestamp and event id headers under the published names', async ({ send }) => {
        const { headers } = await capture(send);
        expect(headers[WEBHOOK_TIMESTAMP_HEADER]).toBe(AT);
        expect(headers[WEBHOOK_EVENT_ID_HEADER]).toBeTruthy();
    });
});
