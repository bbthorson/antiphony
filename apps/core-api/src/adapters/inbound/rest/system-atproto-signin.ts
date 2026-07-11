import { Hono } from 'hono';
import { z } from 'zod';
import { requireSystemAuth } from '../../../middleware/system-auth.js';
import { getAdminAuth, getAdminDb } from '../../../lib/firebase-admin.js';
import { userService } from '../../outbound/firebase/core-services-firebase.js';
import { firebaseUserDependencies } from '../../outbound/firebase/users-dependencies.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { logger } from '../../../lib/logger.js';
import { ConflictError } from 'shared/errors';

/**
 * System-auth endpoint that completes the AT Protocol login flow.
 * Called by apps/web's `/api/v1/atproto/callback` when `state.mode === 'login'`.
 *
 * POST /api/v1/system/atproto/signin
 *   { did: string, handle: string }
 *   → { customToken: string, uid: string, isNewUser: boolean }
 *
 * Finds an existing user by DID, or creates a new Firebase Auth user +
 * Firestore profile with an auto-derived handle, then mints a custom token
 * so the client can complete sign-in via `signInWithCustomToken`.
 */

const DID_REGEX = /^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$/;

const BodySchema = z.object({
    did: z.string().min(1).max(512).regex(DID_REGEX, 'did must be a valid DID'),
    handle: z.string().min(1).max(256),
});

/**
 * Derive a tenant-local handle from a Bluesky handle.
 * 'brad.bsky.social' → 'brad', 'user.custom.domain' → 'user'
 */
function deriveHandle(blueskyHandle: string): string {
    const base = blueskyHandle.split('.')[0].toLowerCase();
    const sanitized = base.replace(/[^a-z0-9_]/g, '_');
    const padded = sanitized.length < 3 ? sanitized.padEnd(3, '0') : sanitized;
    return padded.slice(0, 20);
}

/**
 * Try to claim a handle for a new user. Attempts base, base_2…base_5,
 * then falls back to a uid-derived handle that can never collide.
 */
async function claimHandleForNewUser(
    uid: string,
    blueskyHandle: string,
    did: string,
): Promise<string> {
    const base = deriveHandle(blueskyHandle);
    const displayName = blueskyHandle.split('.')[0];
    const candidates = [
        base,
        `${base.slice(0, 18)}_2`,
        `${base.slice(0, 18)}_3`,
        `${base.slice(0, 18)}_4`,
        `${base.slice(0, 18)}_5`,
    ];

    for (const candidate of candidates) {
        try {
            await firebaseUserDependencies.updateUserProfile(uid, {
                handle: candidate,
                displayName,
            });
            await firebaseUserDependencies.setBlueskyIdentity(uid, { handle: blueskyHandle, did });
            return candidate;
        } catch (err) {
            if (err instanceof ConflictError) continue;
            throw err;
        }
    }

    // Guaranteed-unique fallback — uid prefix is unique, can't collide.
    // 15 chars of uid keeps max length at 20 (5-char 'user_' prefix).
    const fallback = `user_${uid.slice(0, 15).toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    await firebaseUserDependencies.updateUserProfile(uid, {
        handle: fallback,
        displayName,
    });
    await firebaseUserDependencies.setBlueskyIdentity(uid, { handle: blueskyHandle, did });
    return fallback;
}

const app = new Hono();

app.post('/signin', requireSystemAuth(), async (c) => {
    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = BodySchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid request body', { issues: validation.error.issues }),
            400,
        );
    }

    const { did, handle } = validation.data;

    // 1. Existing user: find by DID → mint custom token and return
    const existingUid = await userService.findUidByDid(did);
    if (existingUid) {
        const customToken = await getAdminAuth().createCustomToken(existingUid);
        logger.info({ uid: existingUid }, '[atproto-signin] existing user signed in via Bluesky');
        return c.json({ success: true, data: { customToken, uid: existingUid, isNewUser: false } });
    }

    // 2. New user: create Firebase Auth user, set up profile, mint token
    let uid: string;
    try {
        const userRecord = await getAdminAuth().createUser({});
        uid = userRecord.uid;
    } catch (err) {
        logger.error({ err, did }, '[atproto-signin] failed to create Firebase Auth user');
        return c.json(errorEnvelope(c, 'Failed to create user account'), 500);
    }

    try {
        // Creates the Firestore identity-stub doc
        await userService.ensureUserExists(uid);
        // Claims the derived handle atomically and links the Bluesky identity
        const claimedHandle = await claimHandleForNewUser(uid, handle, did);
        const customToken = await getAdminAuth().createCustomToken(uid);
        logger.info(
            { uid, handle: claimedHandle },
            '[atproto-signin] new user created via Bluesky',
        );
        return c.json({ success: true, data: { customToken, uid, isNewUser: true } });
    } catch (err) {
        // Clean up all orphaned data so the DID can be safely retried.
        // Best-effort — log failures but don't surface them to the caller.
        try {
            await getAdminAuth().deleteUser(uid);
        } catch {
            logger.error({ uid }, '[atproto-signin] failed to delete orphan Firebase Auth user');
        }
        try {
            const db = getAdminDb();
            const userDoc = await db.collection('users').doc(uid).get();
            const userData = userDoc.data();
            const batch = db.batch();
            if (userData?.handle) {
                batch.delete(db.collection('handles').doc(userData.handle));
            }
            batch.delete(db.collection('users').doc(uid));
            await batch.commit();
        } catch (cleanupErr) {
            logger.error({ cleanupErr, uid }, '[atproto-signin] failed to clean up orphan Firestore documents');
        }
        logger.error({ err, uid }, '[atproto-signin] failed to set up new user profile');
        return c.json(errorEnvelope(c, 'Failed to initialize user profile'), 500);
    }
});

export { app as systemAtprotoSigninRoute };
