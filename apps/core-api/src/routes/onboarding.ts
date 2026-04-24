import { Hono } from 'hono';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import { rssService } from '../services/core-services-firebase.js';

/**
 * Onboarding-adjacent endpoints mounted at `/api/v1/onboarding`.
 *
 *   POST /import-rss   — validate+parse an RSS URL, return podcast preview
 *
 * Parity with: apps/web/src/app/api/v1/onboarding/import-rss/route.ts
 */

const ImportRssSchema = z.object({
    url: z.string().url(),
});

const app = new Hono();

app.post('/import-rss', requireAuth(), rateLimit(RATE_LIMITS.standard), async (c) => {
    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            {
                status: 'error',
                message: 'Invalid JSON body',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const validation = ImportRssSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid URL',
                issues: validation.error.issues,
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const rssData = await rssService.parseFeed(validation.data.url);
    if (!rssData) {
        return c.json(
            {
                status: 'error',
                message: 'Failed to parse RSS feed. Please check the URL.',
                requestId: c.get('requestId'),
            },
            422,
        );
    }

    return c.json({
        success: true,
        data: {
            title: rssData.title,
            description: rssData.description,
            image: rssData.image,
            link: rssData.link,
            // Preview the 3 most recent items — matches apps/web parity.
            items: rssData.items?.slice(0, 3),
        },
    });
});

export { app as onboardingRoute };
