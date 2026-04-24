import admin from 'firebase-admin';
import { Hono } from 'hono';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import { firebaseUserDependencies } from '../services/users-dependencies.js';
import { userService } from '../services/core-services-firebase.js';
import { getAdminDb } from '../lib/firebase-admin.js';
import { APP_CONFIG } from '../lib/app-config.js';
import { logger } from '../lib/logger.js';

/**
 * GET /api/v1/handles
 *
 * Returns every public handle (doc IDs of the `handles` collection).
 * Used by the sitemap generator to enumerate user profile URLs. Public —
 * no auth required; rate-limited by IP per `RATE_LIMITS.read`.
 *
 * Response shape (matches apps/web's parity endpoint):
 *   { success: true, data: string[] }
 *
 * Parity with: apps/web/src/app/api/v1/handles/route.ts
 *
 * GET /api/v1/handles/check?handle=xyz
 *
 * Availability check for a handle during signup / profile edit. Requires an
 * authenticated viewer so the endpoint can flag "taken by you" (`owned: true`)
 * distinctly from "taken by someone else" (`available: false`). Matches
 * apps/web's parity endpoint semantics.
 *
 * Response shape:
 *   - `{ available: true }` — handle is free
 *   - `{ available: true, owned: true }` — handle is owned by the viewer
 *   - `{ available: false, reason: 'invalid' | 'taken' }` — not usable
 *
 * Uses the existing `resolveHandle` binding method directly rather than
 * adding a dedicated `UserService` method. The underlying operation is a
 * single handle-doc read, and this mirrors apps/web's route which also
 * bypasses the service layer for this check.
 *
 * Parity with: apps/web/src/app/api/v1/handles/check/route.ts
 */

const app = new Hono();

app.get('/', rateLimit(RATE_LIMITS.read), async (c) => {
    const handles = await userService.getAllPublicHandles();
    return c.json({
        success: true,
        data: handles,
    });
});

const ClaimHandleSchema = z.object({
    handle: z
        .string()
        .min(3)
        .max(20)
        .toLowerCase()
        .regex(/^[a-z0-9_]+$/, 'Handle must be alphanumeric'),
});

/**
 * POST /api/v1/handles/claim
 *
 * Atomic claim: check availability (against both the handles collection
 * AND the organizations.slug space), reserve the handle, and update the
 * user's profile — all in a single transaction.
 *
 * After a successful claim, best-effort add the user to the default Vox
 * Pop org (APP_CONFIG.DEFAULT_ORG_*). Fire-and-forget — the claim is
 * already committed; failure to join the default org doesn't undo it.
 */
app.post('/claim', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            { status: 'error', message: 'Invalid JSON body', requestId: c.get('requestId') },
            400,
        );
    }
    const validation = ClaimHandleSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid handle format',
                issues: validation.error.issues,
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const { handle } = validation.data;
    const db = getAdminDb();

    try {
        // Pre-transaction: collectionGroup/where queries inside a Firestore
        // Admin SDK transaction execute as non-transactional reads (the SDK
        // only supports document `get()` calls inside a transaction). So
        // run the org-slug cross-check outside the transaction and accept
        // the narrow race (an org getting created with this slug between
        // check and commit is rare — and the transaction's handle-write
        // still wins the handle reservation).
        const orgQuery = await db
            .collection('organizations')
            .where('slug', '==', handle)
            .limit(1)
            .get();
        if (!orgQuery.empty) {
            throw new Error('Handle is already taken');
        }

        await db.runTransaction(async (t) => {
            const handleRef = db.collection('handles').doc(handle);
            const userRef = db.collection('users').doc(uid);
            const handleDoc = await t.get(handleRef);

            if (handleDoc.exists) {
                const ownerUid = handleDoc.data()?.uid;
                if (ownerUid !== uid) {
                    throw new Error('Handle is already taken');
                }
                // Already owned by this user — skip the handle-doc write so
                // we preserve the original createdAt timestamp. Only refresh
                // the user-doc pointer.
            } else {
                t.set(handleRef, {
                    uid,
                    createdAt: admin.firestore.Timestamp.now(),
                });
            }

            t.set(
                userRef,
                {
                    handle,
                    domain: APP_CONFIG.DOMAIN,
                    updatedAt: admin.firestore.Timestamp.now(),
                },
                { merge: true },
            );
        });

        // Fire-and-forget default-org membership. Logs on failure; claim
        // has already succeeded at this point, so any failure here is
        // recoverable via the periodic sync job.
        ensureDefaultOrgMembership(uid, c.get('requestId')).catch((err) => {
            logger.error(
                { err, uid, requestId: c.get('requestId') },
                '[handles/claim] default-org membership failed',
            );
        });

        return c.json({ success: true, handle, domain: APP_CONFIG.DOMAIN });
    } catch (err) {
        if (err instanceof Error && err.message === 'Handle is already taken') {
            return c.json(
                {
                    status: 'error',
                    message: 'This handle is taken.',
                    requestId: c.get('requestId'),
                },
                409,
            );
        }
        throw err;
    }
});

async function ensureDefaultOrgMembership(userId: string, requestId: string): Promise<void> {
    const db = getAdminDb();
    const orgId = APP_CONFIG.DEFAULT_ORG_ID;
    const orgRef = db.collection('organizations').doc(orgId);
    const memberRef = orgRef.collection('members').doc(userId);

    const memberDoc = await memberRef.get();
    if (memberDoc.exists) return;

    // Idempotent-create the default org doc if it's missing.
    const orgDoc = await orgRef.get();
    if (!orgDoc.exists) {
        await orgRef.set({
            id: orgId,
            name: APP_CONFIG.DEFAULT_ORG_NAME,
            slug: APP_CONFIG.DEFAULT_ORG_SLUG,
            description: `The default ${APP_CONFIG.NAME} community.`,
            ownerId: 'system',
            createdAt: admin.firestore.Timestamp.now(),
            tier: 'free',
            domainVerified: false,
        });
        logger.info(
            { orgId, requestId },
            '[handles/claim] created default org',
        );
    }

    await memberRef.set({
        orgId,
        userId,
        role: 'member',
        joinedAt: admin.firestore.Timestamp.now(),
    });
}

app.get('/check', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const viewerUid = c.get('viewerUid');
    const raw = c.req.query('handle');
    const handle = raw?.toLowerCase();
    if (!handle || handle.length < 3 || !/^[a-z0-9_]+$/.test(handle)) {
        return c.json({ available: false, reason: 'invalid' });
    }

    const ownerUid = await firebaseUserDependencies.resolveHandle(handle);
    if (!ownerUid) {
        return c.json({ available: true });
    }
    if (ownerUid === viewerUid) {
        return c.json({ available: true, owned: true });
    }
    return c.json({ available: false, reason: 'taken' });
});

export { app as handlesRoute };
