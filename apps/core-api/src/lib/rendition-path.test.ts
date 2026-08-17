import { describe, it, expect } from 'vitest';
import {
    asRenditionFormat,
    parseBlobObjectPath,
    renditionMimeType,
    renditionObjectPath,
    RENDITION_FORMAT_NAMES,
} from './rendition-path.js';

/**
 * Rendition path derivation.
 *
 * Most of what matters here is refusal. The format name selects an ffmpeg
 * argument vector in the transcode service, so a value that is not one of our
 * own literals must never get that far — and the path is a storage key
 * composed from two caller-influenced segments, so it must never be able to
 * name an object outside the rendition namespace.
 */

describe('asRenditionFormat', () => {
    it('accepts a supported format', () => {
        expect(asRenditionFormat('mp3')).toBe('mp3');
    });

    it('normalises case and surrounding space', () => {
        expect(asRenditionFormat('  MP3 ')).toBe('mp3');
    });

    it('returns one of OUR literals, not the caller string', () => {
        // The value that reaches the path builder and the transcode service is
        // always from the closed set. `?format=MP3` must not produce the
        // string "MP3" anywhere downstream — that is how a format name ends up
        // in an argument vector or a storage key as caller-authored data.
        const result = asRenditionFormat('MP3');
        expect(result).not.toBe('MP3');
        expect(RENDITION_FORMAT_NAMES).toContain(result);
    });

    it.each([
        ['wav', 'a plausible format with no entry yet'],
        ['', 'empty'],
        ['mp3;rm -rf /', 'shell metacharacters'],
        ['../../etc/passwd', 'traversal'],
        ['mp3 -f concat', 'an ffmpeg flag smuggled in'],
        ['MP3\n-i /etc/shadow', 'a newline-separated second argument'],
    ])('rejects %s (%s)', (value) => {
        expect(asRenditionFormat(value)).toBeNull();
    });

    it('rejects undefined', () => {
        expect(asRenditionFormat(undefined)).toBeNull();
    });
});

describe('renditionObjectPath', () => {
    it('derives the path from tenant, source CID and format', () => {
        expect(renditionObjectPath('vox-pop', 'bafkreiabc', 'mp3')).toBe(
            'renditions/vox-pop/bafkreiabc.mp3',
        );
    });

    it('is tenant-scoped, so one app cannot address another app rendition', () => {
        const a = renditionObjectPath('app-a', 'bafkreiabc', 'mp3');
        const b = renditionObjectPath('app-b', 'bafkreiabc', 'mp3');
        expect(a).not.toBe(b);
    });

    it('never collides with the canonical namespace', () => {
        // Canonical and derived are strictly separate. A rendition landing
        // under `blobs/` would be a content address that does not match its
        // own bytes — which is the one invariant the whole blob scheme rests
        // on.
        expect(renditionObjectPath('vox-pop', 'bafkreiabc', 'mp3')).not.toMatch(/^blobs\//);
    });

    it.each([
        ['vox/pop', 'bafkreiabc', 'a slash in the tenant'],
        ['vox-pop', 'baf/kreiabc', 'a slash in the CID'],
        ['..', 'bafkreiabc', 'traversal as the tenant'],
        ['vox-pop', '..', 'traversal as the CID'],
        ['vox.pop', 'bafkreiabc', 'a dot in the tenant'],
        ['vox-pop', 'bafkrei.abc', 'a dot in the CID — it would forge the extension boundary'],
        ['', 'bafkreiabc', 'an empty tenant'],
    ])('refuses %s / %s (%s)', (app, cid) => {
        expect(renditionObjectPath(app, cid, 'mp3')).toBeNull();
    });
});

describe('parseBlobObjectPath', () => {
    it('recovers the two segments a rendition is derived from', () => {
        expect(parseBlobObjectPath('blobs/vox-pop/bafkreiabc')).toEqual({
            originAppId: 'vox-pop',
            cid: 'bafkreiabc',
        });
    });

    it.each([
        ['renditions/vox-pop/bafkreiabc.mp3', 'a rendition path, not a blob path'],
        ['blobs/vox-pop', 'too few segments'],
        ['blobs/vox-pop/sub/bafkreiabc', 'too many segments'],
        ['blobs//bafkreiabc', 'an empty tenant segment'],
        ['other/vox-pop/bafkreiabc', 'the wrong prefix'],
    ])('refuses %s (%s)', (path) => {
        expect(parseBlobObjectPath(path)).toBeNull();
    });

    it('round-trips with renditionObjectPath', () => {
        const source = parseBlobObjectPath('blobs/vox-pop/bafkreiabc');
        expect(source).not.toBeNull();
        expect(renditionObjectPath(source!.originAppId, source!.cid, 'mp3')).toBe(
            'renditions/vox-pop/bafkreiabc.mp3',
        );
    });
});

describe('renditionMimeType', () => {
    it('serves mp3 as audio/mpeg', () => {
        // Not `application/octet-stream`, and not whatever the store reports.
        // Twilio reacts to a wrong content type by playing nothing.
        expect(renditionMimeType('mp3')).toBe('audio/mpeg');
    });
});
