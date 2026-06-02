import Parser from 'rss-parser';
import { type Logger, defaultLogger } from '../ports/logger';

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

    private validateUrl(url: string): boolean {
        try {
            const parsedUrl = new URL(url);

            // 1. Protocol check
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                this.logger.warn({ protocol: parsedUrl.protocol }, '[RssService] Blocked unsafe protocol');
                return false;
            }

            // 2. Hostname check
            const hostname = parsedUrl.hostname.toLowerCase();

            // Block localhost/loopback
            if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
                this.logger.warn({ hostname }, '[RssService] Blocked loopback address');
                return false;
            }

            // Block Private IP ranges (basic regex check for IPv4)
            // 10.x.x.x
            if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
            // 192.168.x.x
            if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
            // 172.16.x.x - 172.31.x.x
            if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;

            return true;
        } catch (e) {
            this.logger.error({ err: e }, '[RssService] URL validation error');
            return false;
        }
    }

    async parseFeed(url: string, maxItems: number = 5): Promise<RssSummary | null> {
        if (!this.validateUrl(url)) {
            this.logger.error({ url }, '[RssService] Invalid or unsafe URL');
            return null;
        }

        try {
            const feed = await this.parser.parseURL(url);

            const items: RssItem[] = feed.items.slice(0, maxItems).map(item => ({
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
