import { Hono } from 'hono';
import { z } from 'zod';
import admin from 'firebase-admin';
import { requireSystemAuth } from '../../../middleware/system-auth.js';
import { getAdminDb } from '../../../lib/firebase-admin.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { logger } from '../../../lib/logger.js';

/**
 * System-auth AT Proto OAuth state store mounted at
 * `/api/v1/system/atproto-state/:key`.
 *
 *   GET    /:key — fetch state value; 404 if missing or expired (and
 *                   delete the expired doc as a side effect, matching
 *                   the previous in-process behavior).
 *   PUT    /:key — store a state value, stamping `createdAt` for TTL.
 *   DELETE /:key — remove the state doc (idempotent — DELETE of a
 *                   missing key still returns 200).
 *
 * **Requires system-auth, NOT user-auth.** The caller is apps/web's
 * `@atproto/oauth-client-node` stateStore adapter; end users must never
 * hit this directly. Adding it as a system route lets apps/web drop
 * `firebase-admin` from its dependency tree (PR-F3b stage 2 — the
 * `firebase-admin`-backed StateStore in `apps/web/src/lib/atproto/client.ts`
 * is replaced with a thin HTTP client to this endpoint).
 *
 * ## Storage
 *
 * Firestore collection `atproto_oauth_states`, doc id = `key` (the
 * OAuth state token). One document per in-flight OAuth flow. Stored
 * shape:
 *
 *   { state: <NodeSavedState JSON>, createdAt: <Firestore timestamp> }
 *
 * The TTL is enforced on read: if `Date.now() - createdAt > TTL`, the
 * doc is deleted and the response is 404. Matches the previous
 * in-process implementation in apps/web exactly. No background TTL
 * cleanup — relies on the natural read-side eviction plus the fact that
 * expired entries never resolve a real OAuth flow.
 *
 * ## Body shape
 *
 * PUT body is `{ state: <unknown JSON> }`. The state shape is owned by
 * `@atproto/oauth-client-node` and may evolve; we treat it as an opaque
 * record server-side so a library upgrade doesn't require core-api
 * schema changes.
 */

const STATES_COLLECTION = 'atproto_oauth_states';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches pre-port behavior.

// Firestore doc-id legality: no slashes, no `.` / `..`, length cap. The
// OAuth library generates URL-safe random keys, so this is belt-and-
// suspenders against a future caller passing a path-shaped or reserved
// value that would traverse into a sub-collection.
const KeySchema = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^/]+$/, 'Key must not contain slashes')
    .refine((s) => s !== '.' && s !== '..', { message: 'Key must not be `.` or `..`' });

const PutBodySchema = z
    .object({
        // Treat the state value as an opaque JSON object — the shape
        // comes from `@atproto/oauth-client-node` and may evolve with
        // library upgrades. We store it as-is and round-trip it through
        // JSON.
        state: z.unknown(),
    })
    // `z.unknown()` accepts missing keys by default — `{}` and
    // `{ state: undefined }` both parse. We need the key present (any
    // value the library hands us is fine, including null), so refine.
    .refine((v) => 'state' in v, {
        message: 'state is required',
        path: ['state'],
    });

const app = new Hono();

app.get('/:key', requireSystemAuth(), async (c) => {
    const keyResult = KeySchema.safeParse(c.req.param('key'));
    if (!keyResult.success) {
        return c.json(errorEnvelope(c, 'Invalid key', { issues: keyResult.error.issues }), 400);
    }
    const key = keyResult.data;

    const db = getAdminDb();
    const ref = db.collection(STATES_COLLECTION).doc(key);
    const doc = await ref.get();
    if (!doc.exists) {
        return c.json(errorEnvelope(c, 'State not found'), 404);
    }

    const data = doc.data();
    if (!data) {
        return c.json(errorEnvelope(c, 'State not found'), 404);
    }

    // TTL check — mirrors the previous in-process implementation. Both
    // Firestore Timestamp (`toMillis()`) and raw-number storage are
    // accepted to keep backward-compat with any docs that may have been
    // written by the old code path while the migration was in flight.
    const createdAt =
        typeof data.createdAt?.toMillis === 'function'
            ? data.createdAt.toMillis()
            : typeof data.createdAt === 'number'
              ? data.createdAt
              : null;

    // Fail closed on missing/malformed `createdAt`: this store holds
    // OAuth crypto material (DPoP keypair + PKCE verifier), so
    // "indeterminate age" must be treated as expired rather than
    // returned. Both the unknown-age and over-TTL branches delete the
    // doc; the cleanup is best-effort — if delete throws, log + still
    // return 404 so a transient Firestore error doesn't surface a 500
    // to the OAuth library for a state we've already decided is
    // unusable.
    if (createdAt === null || Date.now() - createdAt > STATE_TTL_MS) {
        try {
            await ref.delete();
        } catch (err) {
            logger.warn(
                { key, err: err instanceof Error ? err.message : String(err) },
                'atproto-state TTL-cleanup delete failed',
            );
        }
        return c.json(
            errorEnvelope(c, createdAt === null ? 'State invalid' : 'State expired'),
            404,
        );
    }

    return c.json({ success: true, data: { state: data.state } });
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
    await db.collection(STATES_COLLECTION).doc(key).set({
        state: validation.data.state,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
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
    await db.collection(STATES_COLLECTION).doc(key).delete();
    return c.json({ success: true, data: null });
});

export { app as systemAtprotoStateRoute };
