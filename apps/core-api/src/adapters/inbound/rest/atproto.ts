import { Hono } from 'hono';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { userService } from '../../outbound/firebase/core-services-firebase.js';

/**
 * AT Protocol routes mounted at `/api/v1/atproto`.
 *
 *   POST /disconnect — remove the linked AT Proto identity from the
 *                       authenticated user's profile.
 *
 * Scope as of PR-F3b stage 2: only `disconnect` lives here. The OAuth
 * flow endpoints (`authorize`, `callback`, `client-metadata.json`) stay
 * on apps/web because the OAuth callback URL is registered with the PDS
 * and tied to apps/web's origin — moving them is a separate, larger
 * effort tracked under `specs/4c-atproto-prompts.md`.
 *
 * Parity source: apps/web/src/app/api/v1/atproto/disconnect/route.ts
 * (deleted in this PR — `web-only-deferred` → `core-only`).
 */

const app = new Hono();

app.post('/disconnect', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    await userService.disconnectAtproto(uid);
    return c.json({ success: true, data: null });
});

export { app as atprotoRoute };
