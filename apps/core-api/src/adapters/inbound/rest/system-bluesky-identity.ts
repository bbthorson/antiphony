import { Hono } from 'hono';
import { z } from 'zod';
import { requireSystemAuth } from '../../../middleware/system-auth.js';
import { userService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

/**
 * System-auth bluesky-identity write endpoint mounted at
 * `/api/v1/system/users/:uid/bluesky-identity`.
 *
 *   PUT /:uid/bluesky-identity — store `{handle, did}` on the user.
 *
 * **Requires system-auth, NOT user-auth.** Called by apps/web's
 * `/api/v1/atproto/callback` route after the OAuth flow completes
 * server-side. The user-auth context isn't available at callback
 * time (the request comes from the PDS, not the user's browser), so
 * the caller authenticates as a sibling service and passes the uid
 * extracted from the OAuth state token.
 *
 * PR-F3b stage 5: this is the deferred port flagged in stage 3 — the
 * last production `firebase-admin` user in apps/web.
 *
 * ## Body shape
 *
 *   { handle: string, did: string }
 *
 * `did` is the AT Proto DID (`did:plc:...` or `did:web:...`); `handle`
 * is the human-readable Bluesky handle (e.g. `brad.bsky.social`).
 * Both are kept short for storage hygiene; a misconfigured caller
 * sending megabytes gets a 400.
 *
 * ## Response
 *
 *   200 { success: true, data: null }
 *
 *   404 { success: false, error: { message }, requestId }
 *        — `userService.setBlueskyIdentity` requires the user doc to
 *        exist. Surfacing as 404 so the caller can map to a redirect
 *        with an "account_missing" reason.
 */

const PutBodySchema = z.object({
    handle: z.string().min(1).max(256),
    did: z
        .string()
        .min(1)
        .max(512)
        // DID grammar — `did:<method>:<method-specific-id>`. The method
        // part is lowercase alphanumeric per the W3C DID spec; the
        // method-specific-id allows colons (for `did:web` hierarchical
        // paths like `did:web:example.com:user`) and percent-encoding
        // (for `did:web:localhost%3A8080`). Underscore + hyphen + dot
        // cover the remaining safe chars used by `did:plc`.
        .regex(/^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$/, 'did must be a valid DID'),
});

const UidSchema = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^/]+$/, 'uid must not contain slashes');

const app = new Hono();

app.put('/:uid/bluesky-identity', requireSystemAuth(), async (c) => {
    const uidResult = UidSchema.safeParse(c.req.param('uid'));
    if (!uidResult.success) {
        return c.json(errorEnvelope(c, 'Invalid uid', { issues: uidResult.error.issues }), 400);
    }
    const uid = uidResult.data;

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

    try {
        await userService.setBlueskyIdentity(uid, validation.data);
    } catch (err) {
        // Firestore `update` on a missing doc throws NOT_FOUND (code 5).
        // Surface as 404 so the apps/web callback can redirect with a
        // meaningful error reason instead of 500.
        const code = (err as { code?: unknown })?.code;
        if (code === 5 || code === 'NOT_FOUND') {
            return c.json(errorEnvelope(c, 'User not found'), 404);
        }
        throw err;
    }

    return c.json({ success: true, data: null });
});

export { app as systemBlueskyIdentityRoute };
