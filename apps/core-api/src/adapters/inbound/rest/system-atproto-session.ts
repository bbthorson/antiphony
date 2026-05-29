import { Hono } from 'hono';
import { z } from 'zod';
import admin from 'firebase-admin';
import { requireSystemAuth } from '../../../middleware/system-auth.js';
import { getAdminDb } from '../../../lib/firebase-admin.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

/**
 * System-auth AT Proto session store mounted at
 * `/api/v1/system/atproto-session/:key`.
 *
 *   GET    /:key — fetch session ciphertext; 404 if missing.
 *   PUT    /:key — store session ciphertext.
 *   DELETE /:key — remove the session doc (idempotent).
 *
 * **Requires system-auth, NOT user-auth.** The caller is apps/web's
 * `@atproto/oauth-client-node` sessionStore adapter; end users must
 * never hit this directly. Mirrors the design of
 * `/api/v1/system/atproto-state/:key` — apps/web holds the encryption
 * key, so this endpoint sees only opaque ciphertext.
 *
 * ## Storage
 *
 * Firestore collection `atproto_oauth_sessions`, doc id = `key` (the
 * user's AT Protocol DID). One document per linked identity. Stored
 * shape:
 *
 *   { ciphertext: <string>, updatedAt: <Firestore timestamp> }
 *
 * **No TTL.** Unlike the state store (10-minute crypto material), DPoP
 * sessions are long-lived — the OAuth client refreshes them on demand
 * via the saved refresh token. A user disconnecting their AT Proto
 * identity DELETEs the doc; otherwise it persists.
 *
 * ## Encryption boundary
 *
 * The session payload contains DPoP keypairs + refresh tokens — high
 * sensitivity. apps/web encrypts client-side with `SESSION_ENCRYPTION_KEY`
 * (AES-256-GCM) before PUTting. core-api never sees plaintext, never
 * holds the key. If core-api is compromised, an attacker gets opaque
 * ciphertext only; without `SESSION_ENCRYPTION_KEY` (held only by
 * apps/web's runtime) they can't decrypt.
 *
 * ## Body shape
 *
 * PUT body is `{ ciphertext: string }`. core-api validates only that
 * the field is present and a string — the format is opaque (the
 * apps/web encryption helper owns the encoding).
 */

const SESSIONS_COLLECTION = 'atproto_oauth_sessions';

// Firestore doc-id legality — same constraints as the state store.
const KeySchema = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^/]+$/, 'Key must not contain slashes')
    .refine((s) => s !== '.' && s !== '..', { message: 'Key must not be `.` or `..`' });

// Generous cap — a typical AES-GCM-encoded session blob is a few KB.
// Reject pathological payloads at the validation boundary so a runaway
// caller can't write a 1MB document.
const MAX_CIPHERTEXT_LEN = 64 * 1024;

const PutBodySchema = z.object({
    ciphertext: z.string().min(1).max(MAX_CIPHERTEXT_LEN),
});

const app = new Hono();

app.get('/:key', requireSystemAuth(), async (c) => {
    const keyResult = KeySchema.safeParse(c.req.param('key'));
    if (!keyResult.success) {
        return c.json(errorEnvelope(c, 'Invalid key', { issues: keyResult.error.issues }), 400);
    }
    const key = keyResult.data;

    const db = getAdminDb();
    const ref = db.collection(SESSIONS_COLLECTION).doc(key);
    const doc = await ref.get();
    if (!doc.exists) {
        return c.json(errorEnvelope(c, 'Session not found'), 404);
    }

    const data = doc.data();
    if (!data || typeof data.ciphertext !== 'string') {
        return c.json(errorEnvelope(c, 'Session not found'), 404);
    }

    return c.json({ success: true, data: { ciphertext: data.ciphertext } });
});

app.put('/:key', requireSystemAuth(), async (c) => {
    const keyResult = KeySchema.safeParse(c.req.param('key'));
    if (!keyResult.success) {
        return c.json(errorEnvelope(c, 'Invalid key', { issues: keyResult.error.issues }), 400);
    }
    const key = keyResult.data;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = PutBodySchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid request body', { issues: validation.error.issues }),
            400,
        );
    }

    const db = getAdminDb();
    await db.collection(SESSIONS_COLLECTION).doc(key).set({
        ciphertext: validation.data.ciphertext,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return c.json({ success: true, data: null });
});

app.delete('/:key', requireSystemAuth(), async (c) => {
    const keyResult = KeySchema.safeParse(c.req.param('key'));
    if (!keyResult.success) {
        return c.json(errorEnvelope(c, 'Invalid key', { issues: keyResult.error.issues }), 400);
    }
    const key = keyResult.data;

    const db = getAdminDb();
    await db.collection(SESSIONS_COLLECTION).doc(key).delete();
    return c.json({ success: true, data: null });
});

export { app as systemAtprotoSessionRoute };
