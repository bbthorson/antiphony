import { describe, it, expect } from 'vitest';
import {
    asRenditionFormat,
    buildRendition,
    InvalidRequestError,
    parseRequest,
    renditionPath,
    sourcePath,
    RENDITION_FORMATS,
} from './rendition.js';
import type { BlobStore } from './lib/blob-store.js';

/**
 * The transcode core.
 *
 * The input boundary is the whole security story of this service now, and it is
 * much smaller than what it replaced: two path segments and a format key, all
 * from a system-authed caller. What the Vox Pop version needed — URL parsing, a
 * host allowlist, a pinned bucket — has nothing to guard here, because no
 * caller-supplied URL is ever fetched. See README.md.
 *
 * So these cover the two things that DO still matter: a format name must never
 * become an ffmpeg argument, and a path segment must never escape its namespace.
 */

process.env.LOG_LEVEL = 'silent';

/**
 * Whether this machine can run the real transcode.
 *
 * Probed once here rather than inside the test, so the gate is a declared
 * `skipIf` and a missing binary is REPORTED rather than quietly passing. The
 * image is guaranteed to have ffmpeg by the Dockerfile's build-time assert; a
 * developer machine is not.
 */
const HAS_FFMPEG = await (async () => {
    const { ffmpegAvailable } = await import('./rendition.js');
    return ffmpegAvailable();
})();

const REQ = { originAppId: 'vox-pop', cid: 'bafkreiabc', format: 'mp3' } as const;

/** An in-memory store, so nothing here needs credentials or a network. */
function fakeStore(seed: Record<string, Buffer> = {}) {
    const objects = new Map<string, Buffer>(Object.entries(seed));
    const writes: { path: string; contentType: string }[] = [];
    const store: BlobStore = {
        read: async (p) => objects.get(p) ?? null,
        head: async (p) => objects.get(p)?.length ?? null,
        write: async (p, bytes, contentType) => {
            objects.set(p, bytes);
            writes.push({ path: p, contentType });
        },
    };
    return { store, objects, writes };
}

describe('asRenditionFormat', () => {
    it('accepts a supported format and normalises it', () => {
        expect(asRenditionFormat('mp3')).toBe('mp3');
        expect(asRenditionFormat('  MP3 ')).toBe('mp3');
    });

    it('returns one of OUR literals, never the caller string', () => {
        // The returned value indexes an ffmpeg argument vector. If the caller's
        // bytes could survive this call they would reach `spawn`.
        const result = asRenditionFormat('MP3');
        expect(result).not.toBe('MP3');
        expect(RENDITION_FORMATS).toContain(result);
    });

    it.each([
        'wav',
        '',
        'mp3 -f concat',
        'mp3;id',
        '../../etc/passwd',
        'mp3\n-i /etc/shadow',
    ])('rejects %j', (value) => {
        expect(asRenditionFormat(value)).toBeNull();
    });

    it.each([[undefined], [null], [42], [{}], [['mp3']]])('rejects the non-string %j', (value) => {
        expect(asRenditionFormat(value)).toBeNull();
    });
});

describe('parseRequest', () => {
    it('accepts a well-formed request', () => {
        expect(parseRequest({ ...REQ })).toEqual(REQ);
    });

    const REJECTED: [unknown, string][] = [
        [{ cid: 'bafkreiabc', format: 'mp3' }, 'no originAppId'],
        [{ originAppId: 'vox-pop', format: 'mp3' }, 'no cid'],
        [{ originAppId: 'vox-pop', cid: 'bafkreiabc' }, 'no format'],
        [{ originAppId: 'vox/pop', cid: 'bafkreiabc', format: 'mp3' }, 'a slash in the tenant'],
        [{ originAppId: 'vox-pop', cid: '../secrets', format: 'mp3' }, 'traversal in the cid'],
        [{ originAppId: 'vox-pop', cid: 'baf.kreiabc', format: 'mp3' }, 'a dot in the cid'],
        [{ originAppId: '', cid: 'bafkreiabc', format: 'mp3' }, 'an empty tenant'],
        [{ originAppId: 'vox-pop', cid: 'bafkreiabc', format: 'wav' }, 'an unknown format'],
        [null, 'a null body'],
        ['not an object', 'a string body'],
    ];

    it.each(REJECTED)('rejects %j (%s)', (body) => {
        expect(() => parseRequest(body)).toThrow(InvalidRequestError);
    });
});

describe('paths', () => {
    it('reads the canonical blob and writes the derived one', () => {
        expect(sourcePath(REQ)).toBe('blobs/vox-pop/bafkreiabc');
        expect(renditionPath(REQ)).toBe('renditions/vox-pop/bafkreiabc.mp3');
    });

    it('never writes into the canonical namespace', () => {
        // A rendition under `blobs/` would be a content address that does not
        // match its own bytes — the one invariant the whole blob scheme rests
        // on. Canonical and derived stay strictly separate.
        expect(renditionPath(REQ)).not.toMatch(/^blobs\//);
    });

    it('is tenant-scoped, so one tenant cannot reach another rendition', () => {
        expect(renditionPath({ ...REQ, originAppId: 'other' })).not.toBe(renditionPath(REQ));
    });
});

describe('buildRendition', () => {
    it('short-circuits when the rendition already exists', async () => {
        // The caller's cache check and this one race: the Worker 404s on a miss,
        // asks us, and by then another request may have built it. A HEAD is far
        // cheaper than an ffmpeg run.
        const { store, writes } = fakeStore({
            'renditions/vox-pop/bafkreiabc.mp3': Buffer.from('already here'),
        });

        const result = await buildRendition(REQ, store);

        expect(result).toEqual({
            path: 'renditions/vox-pop/bafkreiabc.mp3',
            bytes: 12,
            transcoded: false,
        });
        expect(writes).toEqual([]);
    });

    it('rejects a request whose SOURCE does not exist', async () => {
        // Distinguished from a transcode failure on purpose: this is the
        // caller's input being wrong, and the app renders it 404 rather than 502
        // so nobody goes looking at ffmpeg.
        const { store } = fakeStore();

        await expect(buildRendition(REQ, store)).rejects.toThrow(InvalidRequestError);
    });

    // Uses the real ffmpeg binary over synthesised audio, so this covers the
    // argument vector rather than mocking past it.
    //
    // `skipIf`, NOT an early `return`. An early return reports as a PASS, which
    // makes "ffmpeg is missing so this never ran" indistinguishable from "the
    // transcode works" — and the machine most likely to be missing ffmpeg is a
    // CI runner, i.e. exactly where nobody is reading the output. A declared
    // skip shows up in the summary as a skip.
    it.skipIf(!HAS_FFMPEG)('transcodes a real source and writes it with the format content type', async () => {
        const { execFileSync } = await import('node:child_process');
        const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');

        const dir = mkdtempSync(join(tmpdir(), 'rendition-fixture-'));
        try {
            const wav = join(dir, 'tone.wav');
            // Half a second of sine, which is enough to produce a valid mp3.
            execFileSync('ffmpeg', [
                '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
                '-y', wav,
            ]);

            const { store, objects, writes } = fakeStore({
                'blobs/vox-pop/bafkreiabc': readFileSync(wav),
            });

            const result = await buildRendition(REQ, store);

            expect(result.transcoded).toBe(true);
            expect(result.bytes).toBeGreaterThan(0);
            expect(writes).toEqual([
                { path: 'renditions/vox-pop/bafkreiabc.mp3', contentType: 'audio/mpeg' },
            ]);

            // Real mp3 bytes: an ID3 tag or an MPEG frame sync.
            const out = objects.get('renditions/vox-pop/bafkreiabc.mp3')!;
            const isMp3 =
                out.subarray(0, 3).toString('latin1') === 'ID3' ||
                (out[0] === 0xff && (out[1] & 0xe0) === 0xe0);
            expect(isMp3).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('cleans up its temp directory even when the transcode fails', async () => {
        // Instances are reused, so a leaked temp dir accumulates until the
        // container recycles. The failure path is the one that leaks.
        const { store } = fakeStore({
            'blobs/vox-pop/bafkreiabc': Buffer.from('not audio at all'),
        });
        const { readdirSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const before = readdirSync(tmpdir()).filter((n) => n.startsWith('rendition-')).length;

        await expect(buildRendition(REQ, store)).rejects.toThrow();

        const after = readdirSync(tmpdir()).filter((n) => n.startsWith('rendition-')).length;
        expect(after).toBe(before);
    });
});
