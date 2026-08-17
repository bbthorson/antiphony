import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * `audioBucketKey` — the object-derived rate-limit bucket for the audio proxy.
 *
 * This is a security-relevant function in an unusual direction: its job is to
 * SEPARATE callers who should not share a bucket, and the failure that matters
 * is separating too eagerly. A key derived from the request has unbounded
 * cardinality, so any input that can reach the key can mint a fresh limit —
 * which is a bypass, not a leak. Every "returns null" case below is that
 * defence, not tidiness.
 *
 * The complementary risk is under-separating: if two different objects share a
 * bucket, Twilio's concurrent calls throttle each other, which is the bug the
 * whole change exists to remove.
 */

vi.mock('../../../composition.js', () => ({
    // The real storage adapter recognises provider URLs; for keying, the bare
    // path branch is what matters and this keeps the test off the composition
    // root entirely.
    servicesFor: () => ({ storage: { extractObjectPath: () => null } }),
}));

let audioBucketKey: (c: never) => string | null;

beforeEach(async () => {
    ({ audioBucketKey } = (await import('./audio.js')) as unknown as {
        audioBucketKey: (c: never) => string | null;
    });
});

/** Run the key function against a real request, via a throwaway route. */
async function keyFor(query: string): Promise<string | null> {
    let captured: string | null = 'UNSET';
    const a = new Hono();
    a.get('/audio', (c) => {
        captured = audioBucketKey(c as never);
        return c.body(null, 204);
    });
    await a.request(`/audio${query}`);
    return captured;
}

describe('audioBucketKey', () => {
    it('keys a canonical request on the object path', async () => {
        expect(await keyFor('?url=blobs/voxpop/bafy123')).toBe('audio:canonical:blobs/voxpop/bafy123');
    });

    it('separates formats, because the cost is per (object, format)', async () => {
        expect(await keyFor('?url=blobs/voxpop/bafy123&format=mp3')).toBe(
            'audio:mp3:blobs/voxpop/bafy123',
        );
    });

    it('gives two different objects two different buckets', async () => {
        const a = await keyFor('?url=blobs/voxpop/aaa');
        const b = await keyFor('?url=blobs/voxpop/bbb');
        // The whole point: two concurrent Twilio calls must not throttle each
        // other just because both arrive from Twilio.
        expect(a).not.toBe(b);
    });

    it('falls back to the IP for a path outside the served namespace', async () => {
        expect(await keyFor('?url=secrets/passwd')).toBeNull();
    });

    it('falls back to the IP for a traversal attempt', async () => {
        expect(await keyFor('?url=blobs/../../etc/passwd')).toBeNull();
    });

    it('falls back to the IP for an absolute URL', async () => {
        expect(await keyFor('?url=https://evil.example/blobs/voxpop/x')).toBeNull();
    });

    it('falls back to the IP for an unsupported format', async () => {
        // Otherwise the format slot is a bucket generator exactly like the path.
        expect(await keyFor('?url=blobs/voxpop/bafy123&format=aiff')).toBeNull();
    });

    it('falls back to the IP when url is missing entirely', async () => {
        expect(await keyFor('')).toBeNull();
    });
});
