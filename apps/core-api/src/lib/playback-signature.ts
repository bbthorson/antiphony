/**
 * Signed playback for audio in a space (specs/spaces.md, Phase 2).
 *
 * A flat post's audio plays from a stable, unsigned proxy URL, as it always has.
 * Audio in a space plays only from a URL carrying `exp` (a Unix time in seconds)
 * and `sig`, an HMAC-SHA256 over the blob's object path and `exp`, keyed by the
 * deployment's `ANTIPHONY_PLAYBACK_SECRET`. The tenant decides who may listen
 * (it's the space's managing app) and Antiphony mints the URL for it, during
 * hydration or `dev.antiphony.audio.getPlaybackUrl`; the proxy only checks the
 * signature. Why not the protocol's space credentials: a browser's
 * `<audio src>` can't attach an HTTP message signature.
 *
 * `format` (an mp3 rendition, say) is deliberately outside the signature: it
 * selects another encoding of the same bytes, so a holder of a valid URL may
 * ask for it, and a telephony client can append it.
 *
 * WebCrypto (`crypto.subtle`) exists in both Workers and Node 22, and its HMAC
 * `verify` compares in constant time.
 */

/** How long a signed playback URL stays valid. Matches the old signed-URL expiry. */
export const PLAYBACK_URL_TTL_SECONDS = 3600;

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function message(objectPath: string, exp: number): Uint8Array<ArrayBuffer> {
    return encoder.encode(`antiphony-playback-v1\n${objectPath}\n${exp}`);
}

function toBase64Url(bytes: ArrayBuffer): string {
    let s = '';
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    try {
        return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    } catch {
        return null;
    }
}

export async function signPlayback(objectPath: string, exp: number, secret: string): Promise<string> {
    const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), message(objectPath, exp));
    return toBase64Url(sig);
}

/**
 * Whether `sig` is a valid, unexpired signature for this object. `nowSeconds`
 * is injectable for tests. Any malformed input is simply not valid.
 */
export async function verifyPlayback(input: {
    objectPath: string;
    exp: string | undefined;
    sig: string | undefined;
    secret: string | undefined;
    nowSeconds?: number;
}): Promise<boolean> {
    const { objectPath, secret } = input;
    if (!secret || !input.exp || !input.sig || !/^\d{1,12}$/.test(input.exp)) return false;
    const exp = Number(input.exp);
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (exp < now) return false;
    const sig = fromBase64Url(input.sig);
    if (!sig) return false;
    return crypto.subtle.verify('HMAC', await hmacKey(secret), sig, message(objectPath, exp));
}
