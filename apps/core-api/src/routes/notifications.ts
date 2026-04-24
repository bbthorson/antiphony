import admin from 'firebase-admin';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { FcmTokenRequestSchema } from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import { getAdminDb } from '../lib/firebase-admin.js';

/**
 * FCM token management for push notifications.
 *
 *   POST /api/v1/notifications/register-token
 *   POST /api/v1/notifications/disable-token
 *
 * Tokens live at `users/{uid}/private_data/fcm.tokens` — a single doc
 * per user with a token array. arrayUnion / arrayRemove is idempotent
 * so repeat register/disable calls are safe.
 *
 * Parity with:
 *   apps/web/src/app/api/v1/notifications/register-token/route.ts
 *   apps/web/src/app/api/v1/notifications/disable-token/route.ts
 */

const app = new Hono();

function fcmDocRef(uid: string) {
    return getAdminDb()
        .collection('users')
        .doc(uid)
        .collection('private_data')
        .doc('fcm');
}

async function parseBody(c: Context) {
    try {
        return { ok: true as const, body: await c.req.json() };
    } catch {
        return { ok: false as const };
    }
}

app.post('/register-token', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const parsed = await parseBody(c);
    if (!parsed.ok) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid JSON body',
                requestId: c.get('requestId'),
            },
            400,
        );
    }
    const validation = FcmTokenRequestSchema.safeParse(parsed.body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid token',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    await fcmDocRef(uid).set(
        { tokens: admin.firestore.FieldValue.arrayUnion(validation.data.token) },
        { merge: true },
    );

    return c.json({ success: true });
});

app.post('/disable-token', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const parsed = await parseBody(c);
    if (!parsed.ok) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid JSON body',
                requestId: c.get('requestId'),
            },
            400,
        );
    }
    const validation = FcmTokenRequestSchema.safeParse(parsed.body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid token',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    await fcmDocRef(uid).set(
        { tokens: admin.firestore.FieldValue.arrayRemove(validation.data.token) },
        { merge: true },
    );

    return c.json({ success: true });
});

export { app as notificationsRoute };
