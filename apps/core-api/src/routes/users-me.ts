import admin from 'firebase-admin';
import { Hono } from 'hono';
import { z } from 'zod';
import { ConflictError } from 'shared/errors';
import { UpdateProfileRequestSchema } from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import { userService, organizationService } from '../services/core-services-firebase.js';
import { firebaseUserDependencies } from '../services/users-dependencies.js';
import { getAdminDb, getAdminAuth } from '../lib/firebase-admin.js';
import { logger } from '../lib/logger.js';

/**
 * Authenticated-viewer "me" endpoints mounted at `/api/v1/users/me`.
 *
 *   GET    /                  — full profile (PII)
 *   PATCH  /                  — update profile (handle-swap + field merge)
 *   GET    /organizations     — hydrated orgs the viewer belongs to
 *   POST   /delete            — soft-delete (deactivate) account
 *
 * Parity sources:
 *   apps/web/src/app/api/v1/users/me/route.ts (GET + PATCH)
 *   apps/web/src/app/api/v1/users/me/organizations/route.ts (GET)
 *   apps/web/src/app/api/v1/users/me/delete/route.ts (POST)
 */

// Use the canonical shared schema — enforces `handle` min(3) + regex that the
// apps/web legacy local schema missed. Extends with fields the handler accepts
// beyond the shared set (email + rssFeedUrl) — these aren't in the shared
// schema today; lifting them there is a separate cleanup.
const UpdateUserSchema = UpdateProfileRequestSchema.extend({
    email: z.string().email().optional(),
    rssFeedUrl: z.string().url().optional(),
}).partial();

const DeleteSchema = z.object({
    confirm: z.literal(true, { errorMap: () => ({ message: 'Confirmation required' }) }),
});

const app = new Hono();

app.get('/', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const profile = await userService.getUserDataByUid(uid);
    if (!profile) {
        return c.json(
            {
                status: 'error',
                message: 'Profile not found',
                requestId: c.get('requestId'),
            },
            404,
        );
    }
    return c.json(profile);
});

app.patch('/', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;

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

    const validation = UpdateUserSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid request',
                issues: validation.error.issues,
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const updates = validation.data;
    const cleanUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, v]) => v !== undefined),
    );

    if (Object.keys(cleanUpdates).length === 0) {
        return c.json({ success: true, message: 'No changes' });
    }

    try {
        // The binding's updateUserProfile does a transactional handle-swap;
        // goes through the binding because apps/web's parity route calls
        // userService.updateUserProfile which is a thin wrapper. We'd need
        // to add that wrapper to UserService first, which is extra work for
        // zero behavior difference.
        await firebaseUserDependencies.updateUserProfile(uid, cleanUpdates);
    } catch (err) {
        if (err instanceof ConflictError) {
            return c.json(
                {
                    status: 'error',
                    message: 'Handle is already taken',
                    requestId: c.get('requestId'),
                },
                409,
            );
        }
        throw err;
    }

    return c.json({
        success: true,
        updates: cleanUpdates,
    });
});

app.get('/organizations', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgs = await organizationService.getUserOrganizations(uid);
    return c.json({
        success: true,
        data: orgs,
    });
});

/**
 * POST /users/me/delete
 *
 * Soft-deletes (deactivates) the authenticated user's account:
 *   - Sets user doc status to 'deactivated' + deactivatedAt stamp
 *   - Releases the handle doc so it can be reclaimed
 *   - Revokes all Firebase Auth refresh tokens (invalidates sessions)
 *
 * Does NOT delete user doc, prompts, replies, or org memberships — the
 * user's content stays intact for recovery / archival purposes.
 *
 * Parity with apps/web's handler, which reaches for getAdminDb / getAdminAuth
 * directly — no equivalent service method exists yet. Keeping the raw
 * pattern here for parity; can tighten into a binding method in a
 * future refactor once apps/web is gone.
 */
app.post('/delete', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            {
                status: 'error',
                message: 'Must include { confirm: true } to delete account',
                requestId: c.get('requestId'),
            },
            400,
        );
    }
    const validation = DeleteSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Must include { confirm: true } to delete account',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    try {
        const db = getAdminDb();
        const adminAuth = getAdminAuth();

        // Transaction: user-doc deactivation + handle release. Keeps the
        // two Firestore ops atomic so we can't end up with a deactivated
        // user whose handle is still taken (or vice versa) on partial
        // failure. Auth token revocation runs after — it's not a Firestore
        // op and has its own idempotent semantics, so splitting it is fine.
        await db.runTransaction(async (t) => {
            const userRef = db.collection('users').doc(uid);
            const userDoc = await t.get(userRef);
            const handle = userDoc.data()?.handle;

            t.update(userRef, {
                status: 'deactivated',
                deactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            if (handle) {
                t.delete(db.collection('handles').doc(handle));
            }
        });

        await adminAuth.revokeRefreshTokens(uid);

        return c.json({
            success: true,
            message:
                'Account deactivated. Your data has been preserved but your account is no longer active.',
        });
    } catch (err) {
        logger.error(
            { err, requestId: c.get('requestId'), uid },
            '[users-me] delete failed',
        );
        return c.json(
            {
                status: 'error',
                message: 'Failed to deactivate account',
                requestId: c.get('requestId'),
            },
            500,
        );
    }
});

export { app as usersMeRoute };
