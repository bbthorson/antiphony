import { Hono } from 'hono';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { rssService } from '../../outbound/firebase/core-services-firebase.js';

/**
 * POST /api/v1/rss/parse
 *
 * Open-core utility — parses an RSS/Atom feed URL and returns a
 * normalized summary plus the first 3 items (preview). Body:
 * `{ url: string }`. Public; no auth.
 *
 * Stateless RPC: server-side fetch is the value (CORS-friendly,
 * consistent parser, no client-side dependency on rss-parser bundles).
 *
 * Replaces the older `/api/v1/utils/parse-rss` and the auth-gated
 * `/api/v1/onboarding/import-rss` — both did the same thing under
 * different paths.
 *
 * ## Response shape
 * `{ success: true, data: RssSummary }` — the standard core-api
 * envelope. Migrated from `{ status: 'success', data }` in envelope
 * Phase 1d so the same `apiData` helper unwraps every endpoint.
 *
 * Rate-limit: `RATE_LIMITS.hourly` with a fixed `rss_parse_<ip>`
 * custom key (one bucket per IP).
 */

const ParseSchema = z.object({
    url: z.string().url(),
});

const app = new Hono();

app.post(
    '/parse',
    async (c, next) => {
        const forwarded = c.req.header('x-forwarded-for') || 'unknown';
        const ip = forwarded.split(',').map((s) => s.trim()).filter(Boolean).pop() || 'unknown';
        const customKey = `rss_parse_${ip}`;
        return rateLimit(RATE_LIMITS.hourly, customKey)(c, next);
    },
    async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = ParseSchema.safeParse(body);
        if (!parsed.success) {
            return c.json(
                {
                    status: 'error',
                    message: 'Invalid request body',
                    issues: parsed.error.issues,
                },
                400,
            );
        }

        const summary = await rssService.parseFeed(parsed.data.url);

        if (!summary) {
            return c.json(
                { status: 'error', message: 'Failed to parse RSS feed or invalid URL' },
                400,
            );
        }

        return c.json({
            success: true,
            data: {
                title: summary.title,
                description: summary.description,
                image: summary.image,
                link: summary.link,
                // Preview the 3 most recent items — matches the old
                // onboarding/import-rss flow used by apps/web onboarding.
                items: summary.items?.slice(0, 3),
            },
        });
    },
);

export { app as rssParseRoute };
