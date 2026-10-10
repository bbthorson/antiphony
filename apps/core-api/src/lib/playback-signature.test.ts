import { describe, it, expect } from 'vitest';
import { PLAYBACK_URL_TTL_SECONDS, signPlayback, verifyPlayback } from './playback-signature.js';

const SECRET = 'test-playback-secret-0123456789abcdef';
const PATH = 'blobs/app-1/bafyreicid';
const NOW = 1_800_000_000;

describe('playback signatures', () => {
    it('verifies its own signature until it expires', async () => {
        const exp = NOW + PLAYBACK_URL_TTL_SECONDS;
        const sig = await signPlayback(PATH, exp, SECRET);
        expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(await verifyPlayback({ objectPath: PATH, exp: String(exp), sig, secret: SECRET, nowSeconds: NOW })).toBe(true);
        expect(await verifyPlayback({ objectPath: PATH, exp: String(exp), sig, secret: SECRET, nowSeconds: exp + 1 })).toBe(false);
    });

    it('binds the object, the expiry and the secret', async () => {
        const exp = NOW + 60;
        const sig = await signPlayback(PATH, exp, SECRET);
        const ok = { objectPath: PATH, exp: String(exp), sig, secret: SECRET, nowSeconds: NOW };
        expect(await verifyPlayback({ ...ok, objectPath: 'blobs/app-2/bafyreicid' })).toBe(false);
        expect(await verifyPlayback({ ...ok, exp: String(exp + 1) })).toBe(false);
        expect(await verifyPlayback({ ...ok, secret: `${SECRET}x` })).toBe(false);
    });

    it('treats anything malformed or missing as unsigned', async () => {
        const base = { objectPath: PATH, secret: SECRET, nowSeconds: NOW };
        expect(await verifyPlayback({ ...base, exp: undefined, sig: undefined })).toBe(false);
        expect(await verifyPlayback({ ...base, exp: '1e12', sig: 'abc' })).toBe(false);
        expect(await verifyPlayback({ ...base, exp: String(NOW + 60), sig: 'not base64!' })).toBe(false);
        const sig = await signPlayback(PATH, NOW + 60, SECRET);
        expect(await verifyPlayback({ ...base, exp: String(NOW + 60), sig, secret: undefined })).toBe(false);
    });
});
