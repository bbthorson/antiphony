import { Hono } from 'hono';
import { FcmTokenRequestSchema } from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { registerFcmToken, disableFcmToken } from '../../outbound/firebase/fcm-token-store.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

/**
 * Notification endpoints mounted at `/api/v1/notifications`.
 *
 *   POST /register-token  — append an FCM device token to the viewer's
 *                           per-user token list.
 *   POST /disable-token   — remove an FCM token from the list.
 *
 * Both auth-required; both per-viewer (no cross-user writes).
 * Idempotent at the Firestore level — re-registering or
 * double-disabling the same token is a no-op.
 *
 * Parity sources (deleted in PR-F3a):
 *   apps/web/src/app/api/v1/notifications/register-token/route.ts
 *   apps/web/src/app/api/v1/notifications/disable-token/route.ts
 */

const app = new Hono();

app.post('/register-token', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const parsed = FcmTokenRequestSchema.safeParse(body);
    if (!parsed.success) {
        return c.json(
            errorEnvelope(c, 'Invalid token', { issues: parsed.error.issues }),
            400,
        );
    }

    await registerFcmToken(uid, parsed.data.token);
    return c.json({ success: true, data: null });
});

app.post('/disable-token', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const parsed = FcmTokenRequestSchema.safeParse(body);
    if (!parsed.success) {
        return c.json(
            errorEnvelope(c, 'Invalid token', { issues: parsed.error.issues }),
            400,
        );
    }

    await disableFcmToken(uid, parsed.data.token);
    return c.json({ success: true, data: null });
});

export { app as notificationsRoute };
