import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from './webhook-signature';

const SECRET = `whsec_test_${'a'.repeat(32)}`;
const BODY = JSON.stringify({ type: 'remote.gone', originAppId: 'vox-pop', uri: 'at://did:plc:x/y/z', occurredAt: '2026-11-12T10:00:00.000Z' });

/** Computed with node:crypto, independently of the WebCrypto code under test. */
const sign = (body: string | Uint8Array, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex');
const GOOD = `sha256=${sign(BODY)}`;

describe('verifyWebhookSignature', () => {
    it('accepts the signature an independent HMAC produces, for a string body', async () => {
        expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signatureHeader: GOOD })).toBe(true);
    });

    it('accepts byte inputs: a Uint8Array and an ArrayBuffer', async () => {
        const bytes = new TextEncoder().encode(BODY);
        expect(await verifyWebhookSignature({ secret: SECRET, rawBody: bytes, signatureHeader: GOOD })).toBe(true);
        expect(await verifyWebhookSignature({ secret: SECRET, rawBody: bytes.buffer, signatureHeader: GOOD })).toBe(true);
    });

    it('signs only the bytes a view addresses, not the buffer behind it', async () => {
        const bytes = new TextEncoder().encode(BODY);
        const padded = new Uint8Array(bytes.length + 10);
        padded.set(bytes, 4);
        const view = padded.subarray(4, 4 + bytes.length);
        expect(await verifyWebhookSignature({ secret: SECRET, rawBody: view, signatureHeader: GOOD })).toBe(true);
    });

    it('verifies non-ASCII bodies over their UTF-8 bytes', async () => {
        const body = JSON.stringify({ note: 'café \u{1F3A4}' });
        const header = `sha256=${sign(body)}`;
        expect(await verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: header })).toBe(true);
    });

    it('accepts upper-case hex, which is the same MAC spelled differently', async () => {
        const header = `sha256=${sign(BODY).toUpperCase()}`;
        expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signatureHeader: header })).toBe(true);
    });

    it('rejects a body changed by one byte', async () => {
        expect(await verifyWebhookSignature({ secret: SECRET, rawBody: BODY.replace('vox-pop', 'vox-pap'), signatureHeader: GOOD })).toBe(false);
    });

    it('rejects a re-serialized body: same data, different bytes', async () => {
        const reserialized = JSON.stringify(JSON.parse(BODY), null, 2);
        expect(await verifyWebhookSignature({ secret: SECRET, rawBody: reserialized, signatureHeader: GOOD })).toBe(false);
    });

    it('rejects the wrong secret', async () => {
        expect(await verifyWebhookSignature({ secret: `${SECRET}x`, rawBody: BODY, signatureHeader: GOOD })).toBe(false);
    });

    it('rejects an empty secret instead of throwing', async () => {
        const header = `sha256=${sign(BODY, '')}`;
        expect(await verifyWebhookSignature({ secret: '', rawBody: BODY, signatureHeader: header })).toBe(false);
    });

    const hex = sign(BODY);
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['empty', ''],
        ['no prefix', hex],
        ['wrong algorithm prefix', `sha1=${hex}`],
        ['upper-case prefix', `SHA256=${hex}`],
        ['prefix only', 'sha256='],
        ['non-hex', `sha256=${'z'.repeat(64)}`],
        ['one non-hex character', `sha256=${hex.slice(0, 63)}g`],
        ['too short', `sha256=${hex.slice(0, 62)}`],
        ['too long', `sha256=${hex}00`],
        ['odd length', `sha256=${hex.slice(0, 63)}`],
        ['leading space', ` sha256=${hex}`],
        ['trailing newline', `sha256=${hex}\n`],
    ])('returns false, without throwing, for a header that is %s', async (_name, signatureHeader) => {
        await expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, signatureHeader })).resolves.toBe(false);
    });
});
