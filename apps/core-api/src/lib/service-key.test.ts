import { describe, it, expect } from 'vitest';
import { generateServiceKey, derivePublicKeyMultibase } from './service-key.js';
import { importMultikeyP256 } from './signed-service-auth.js';

describe('service key', () => {
    it('derives from a generated private key the public key it was generated with', async () => {
        const key = await generateServiceKey();
        expect(key.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
        expect(key.publicKeyMultibase).toMatch(/^z[1-9A-HJ-NP-Za-km-z]+$/);
        expect(await derivePublicKeyMultibase(key.privateKeyHex)).toBe(key.publicKeyMultibase);
    });

    it('generates a different key each time', async () => {
        const [a, b] = await Promise.all([generateServiceKey(), generateServiceKey()]);
        expect(a.privateKeyHex).not.toBe(b.privateKeyHex);
    });

    it('produces a public key that signed-service-auth decodes, and that verifies a signature from the private key', async () => {
        const key = await generateServiceKey();
        const verifyKey = await importMultikeyP256(key.publicKeyMultibase);
        expect(verifyKey).not.toBeNull();

        // The round trip that matters is the whole one: sign with the exported
        // private scalar, verify with the key the document would publish.
        const { P256Keypair } = await import('@atproto/crypto');
        const signer = await P256Keypair.import(key.privateKeyHex);
        const message = new TextEncoder().encode('header.payload');
        const signature = await signer.sign(message);
        const ok = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            verifyKey!,
            signature as Uint8Array<ArrayBuffer>,
            message,
        );
        expect(ok).toBe(true);
    });

    it.each([
        ['empty', ''],
        ['not hex', 'z'.repeat(64)],
        ['too short', 'ab'.repeat(31)],
        ['too long', 'ab'.repeat(33)],
        ['uppercase', 'AB'.repeat(32)],
        ['all zero, which is not a valid scalar', '00'.repeat(32)],
        ['at or above the curve order', 'ff'.repeat(32)],
    ])('fails cleanly, with null, on a malformed private key: %s', async (_name, value) => {
        await expect(derivePublicKeyMultibase(value)).resolves.toBeNull();
    });
});
