import { P256Keypair } from '@atproto/crypto';

/**
 * Antiphony's own P-256 signing key, as two strings an operator can handle.
 *
 * The private half is the hex that `P256Keypair.export()` returns and
 * `P256Keypair.import()` takes, and it is a Worker secret. The public half is
 * the multibase Multikey (`z…`), which is the part of the key's `did:key:z…`
 * after the method prefix and the same encoding `importMultikeyP256` in
 * `signed-service-auth.ts` decodes. It is public configuration, and it is what
 * the DID document publishes.
 *
 * Both the key script and the `/.well-known/did.json` route go through this
 * module, so the encoding the operator is told to set is the encoding the
 * route checks it against.
 */

const DID_KEY_PREFIX = 'did:key:';

/** A P-256 scalar is 32 bytes, so 64 hex characters. */
const PRIVATE_KEY_HEX = /^[0-9a-f]{64}$/;

/** What base58btc multibase looks like, before any decoding is attempted. */
const PUBLIC_KEY_MULTIBASE = /^z[1-9A-HJ-NP-Za-km-z]+$/;

export interface ServiceKeyPair {
    /** Hex of the 32-byte private scalar. Secret. */
    privateKeyHex: string;
    /** Multibase Multikey of the compressed public point. Public. */
    publicKeyMultibase: string;
}

function multikeyOf(keypair: P256Keypair): string {
    return keypair.did().slice(DID_KEY_PREFIX.length);
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a fresh keypair. Nothing is stored; the caller decides where it goes. */
export async function generateServiceKey(): Promise<ServiceKeyPair> {
    const keypair = await P256Keypair.create({ exportable: true });
    return {
        privateKeyHex: toHex(await keypair.export()),
        publicKeyMultibase: multikeyOf(keypair),
    };
}

/**
 * The public Multikey for a private key in the secret's format, or `null` when
 * the value is not a usable key.
 *
 * The shape is checked before importing because `P256Keypair.import` decodes a
 * string leniently: it would turn stray characters into some other key rather
 * than refuse them, and a document built from the wrong key is the one failure
 * this setting must not have. The import itself still throws for a scalar that
 * is out of range, which is why it sits in a try.
 */
export async function derivePublicKeyMultibase(privateKeyHex: string): Promise<string | null> {
    if (!PRIVATE_KEY_HEX.test(privateKeyHex)) return null;
    try {
        return multikeyOf(await P256Keypair.import(privateKeyHex));
    } catch {
        return null;
    }
}

/** Whether a value has the shape of a multibase Multikey, without decoding it. */
export function looksLikePublicKeyMultibase(value: string): boolean {
    return PUBLIC_KEY_MULTIBASE.test(value);
}
