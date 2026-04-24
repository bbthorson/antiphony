import { Hono } from 'hono';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { rssService } from '../services/core-services-firebase.js';

/**
 * POST /api/v1/utils/parse-rss
 *
 * Utility endpoint — parses an RSS/Atom feed URL and returns a
 * normalized summary. Body: `{ url: string }`. Public; no auth.
 *
 * Technically a POST (body-carried URL), not a GET. Porting pre-auth-bridge
 * because it's a stateless RPC — no state mutation, no auth requirement.
 * The skill's GET-only rule exists to gate mutation endpoints on the auth
 * bridge; parse-rss is neither.
 *
 * Parity with: apps/web/src/app/api/v1/utils/parse-rss/route.ts
 *
 * ## Response shape parity (including the legacy `status: 'success'`)
 *
 * Apps/web's handler returns `{ status: 'success', data: {...} }` on OK —
 * NOT the `{ success: true, data }` shape used elsewhere. That's a
 * pre-existing inconsistency in the codebase, not a new one. Matching
 * it here exactly so the wire contract doesn't drift during the port.
 * Worth a separate "error-shape standardization" pass later; not this PR.
 *
 * Rate-limit: `RATE_LIMITS.hourly` with a fixed `parse_rss_<ip>` custom
 * key, matching apps/web — one bucket per IP shared across all
 * parse-rss callers.
 */

const ParseSchema = z.object({
    url: z.string().url(),
});

const app = new Hono();

app.post(
    '/',
    async (c, next) => {
        // Use a custom key to scope the rate-limit bucket specifically
        // to parse-rss (not the general read/write IP bucket).
        const forwarded = c.req.header('x-forwarded-for') || 'unknown';
        const ip = forwarded.split(',').map((s) => s.trim()).filter(Boolean).pop() || 'unknown';
        const customKey = `parse_rss_${ip}`;
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

        // Match apps/web's idiosyncratic `status: 'success'` envelope here
        // — see file-header note. NOT the `success: true` shape.
        return c.json({
            status: 'success',
            data: {
                title: summary.title,
                description: summary.description,
                image: summary.image,
                link: summary.link,
            },
        });
    },
);

export { app as parseRssRoute };
