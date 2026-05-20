import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from './firebase-admin.js';

/**
 * Per-user FCM device-token registry.
 *
 * Storage path: `users/{uid}/private_data/fcm`, document shape
 * `{ tokens: string[] }`. Tokens are appended via `arrayUnion` and
 * removed via `arrayRemove` — both idempotent at the Firestore level,
 * so re-registering the same token is a no-op and removing a token
 * that's already gone won't error.
 *
 * Matches the layout of the (now retired) apps/web routes
 * `apps/web/src/app/api/v1/notifications/{register,disable}-token/route.ts`.
 *
 * No service / port abstraction — this is a one-purpose helper with
 * two methods on one document path. If notifications grow (push
 * targeting rules, per-device preferences, channel subscriptions),
 * lift this into a proper service then.
 */

function fcmDocRef(uid: string) {
    return getAdminDb()
        .collection('users')
        .doc(uid)
        .collection('private_data')
        .doc('fcm');
}

export async function registerFcmToken(uid: string, token: string): Promise<void> {
    await fcmDocRef(uid).set(
        { tokens: FieldValue.arrayUnion(token) },
        { merge: true },
    );
}

export async function disableFcmToken(uid: string, token: string): Promise<void> {
    await fcmDocRef(uid).set(
        { tokens: FieldValue.arrayRemove(token) },
        { merge: true },
    );
}
