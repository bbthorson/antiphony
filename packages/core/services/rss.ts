import Parser from 'rss-parser';
import { type Logger, defaultLogger } from '../ports/logger';
import { safeFetchText, isAllowedHost } from './safe-fetch';

/**
 * RssService parses external RSS/Atom feeds into a normalized summary.
 *
 * Lives in `packages/core/` as of Task E.2. Genuinely standalone — no
 * peer-service calls, no Firebase, no data access. The singleton export
 * also lives here because it has no Firebase-wired composition.
 *
 * Accepts an optional `Logger` (defaults to `defaultLogger` / console). The
 * composition layer in `apps/core-api` passes the pino instance.
 */
export interface RssItem {
    title?: string;
    link?: string;
    content?: string;
    pubDate?: string;
}

export interface RssSummary {
    title?: string;
    description?: string;
    image?: string;
    link?: string;
    items?: RssItem[];
    lastFetchedAt?: Date;
}

export class RssService {
    private parser: Parser;

    constructor(private readonly logger: Logger = defaultLogger) {
        this.parser = new Parser();
    }

    /**
     * Fast pre-validation: protocol allowlist + reject a literal non-public IP
     * (or `localhost`) host up front. DNS hostnames pass here and are validated
     * comprehensively at connect time by `safeFetchText`'s SSRF-safe lookup,
     * which resolves the host and rejects any non-public resolved address.
     */
    private validateUrl(url: string): boolean {
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(url);
        } catch (e) {
            this.logger.error({ err: e }, '[RssService] URL validation error');
            return false;
        }

        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            this.logger.warn({ protocol: parsedUrl.protocol }, '[RssService] Blocked unsafe protocol');
            return false;
        }

        if (!isAllowedHost(parsedUrl.hostname)) {
            this.logger.warn({ hostname: parsedUrl.hostname }, '[RssService] Blocked unsafe host');
            return false;
        }

        return true;
    }

    async parseFeed(url: string, maxItems: number = 5): Promise<RssSummary | null> {
        if (!this.validateUrl(url)) {
            this.logger.error({ url }, '[RssService] Invalid or unsafe URL');
            return null;
        }

        try {
            // Fetch through the SSRF-safe client (validates every resolved IP,
            // pins the socket, re-validates redirects), then parse the text —
            // NOT `parser.parseURL`, whose internal fetch follows redirects to
            // arbitrary hosts and does no IP validation.
            const xml = await safeFetchText(url, this.logger);
            const feed = await this.parser.parseString(xml);

            const items: RssItem[] = (feed.items || []).slice(0, maxItems).map(item => ({
                title: item.title,
                link: item.link,
                content: item.contentSnippet || item.content,
                pubDate: item.pubDate,
            }));

            return {
                title: feed.title,
                description: feed.description,
                image: feed.image?.url || feed.itunes?.image,
                link: feed.link,
                items,
                lastFetchedAt: new Date(),
            };
        } catch (error) {
            this.logger.error({ url, err: error }, '[RssService] Error parsing feed');
            return null;
        }
    }
}

export const rssService = new RssService();
