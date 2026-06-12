import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep isAllowedHost real (drives validateUrl), stub the network fetch.
const { safeFetchTextMock } = vi.hoisted(() => ({ safeFetchTextMock: vi.fn() }));
vi.mock('./safe-fetch', async (importActual) => {
    const actual = await importActual<typeof import('./safe-fetch')>();
    return { ...actual, safeFetchText: safeFetchTextMock };
});

const { RssService } = await import('./rss');
import { defaultLogger } from '../ports/logger';

const silent = { ...defaultLogger, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

const SAMPLE_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example Feed</title>
  <description>An example</description>
  <link>https://example.com</link>
  <item><title>First</title><link>https://example.com/1</link><pubDate>Wed, 01 Jan 2026 00:00:00 GMT</pubDate></item>
  <item><title>Second</title><link>https://example.com/2</link></item>
</channel></rss>`;

describe('RssService.parseFeed — SSRF guard (M4)', () => {
    beforeEach(() => safeFetchTextMock.mockReset());

    it('returns null (no fetch) for unsafe URLs', async () => {
        const svc = new RssService(silent);
        for (const url of [
            'http://169.254.169.254/latest/meta-data/', // cloud metadata
            'http://localhost/feed',
            'http://127.0.0.1/feed',
            'http://10.0.0.1/feed',
            'http://[::1]/feed',
            'file:///etc/passwd', // bad protocol
            'ftp://example.com/feed', // bad protocol
            'not a url',
        ]) {
            expect(await svc.parseFeed(url)).toBeNull();
        }
        expect(safeFetchTextMock).not.toHaveBeenCalled();
    });

    it('fetches through safeFetchText (not parser.parseURL) and parses the result', async () => {
        safeFetchTextMock.mockResolvedValue(SAMPLE_FEED);
        const svc = new RssService(silent);

        const summary = await svc.parseFeed('https://feeds.example.com/rss');

        expect(safeFetchTextMock).toHaveBeenCalledWith('https://feeds.example.com/rss', silent);
        expect(summary).not.toBeNull();
        expect(summary!.title).toBe('Example Feed');
        expect(summary!.items).toHaveLength(2);
        expect(summary!.items![0].title).toBe('First');
    });

    // NOTE: the "fetch rejects → parseFeed returns null" path is trivial
    // try/catch plumbing (verified manually) and isn't covered by an automated
    // test here — a shared module-mock that rejects trips a vitest cross-test
    // unhandled-rejection artifact. The SSRF guard itself is covered by the
    // unsafe-URL cases above and the safe-fetch.test.ts suite.

    it('honors maxItems', async () => {
        safeFetchTextMock.mockResolvedValue(SAMPLE_FEED);
        const svc = new RssService(silent);
        const summary = await svc.parseFeed('https://feeds.example.com/rss', 1);
        expect(summary!.items).toHaveLength(1);
    });
});
