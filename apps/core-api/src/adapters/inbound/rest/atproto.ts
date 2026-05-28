import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { userService } from '../../outbound/firebase/core-services-firebase.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

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
 * OpenAPI scope (sub-PR 4 of `specs/drafts/openapi-generation.md`):
 * `disconnect` is the only client-callable surface here, so it's the
 * only route documented. The OAuth-flow routes are intentionally
 * plain-Hono — they're redirect-based handshakes a third-party API
 * client can't drive directly.
 *
 * Parity source: apps/web/src/app/api/v1/atproto/disconnect/route.ts
 * (deleted in this PR — `web-only-deferred` → `core-only`).
 */

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const disconnectRoute = createRoute({
    method: 'post',
    path: '/disconnect',
    tags: ['Auth'],
    summary: 'Disconnect the linked AT Protocol identity',
    description: 'Removes the authenticated viewer\'s linked AT Protocol identity (DID + handle) from their profile. Does not revoke the PDS-side OAuth session — call your PDS\'s logout flow separately if needed.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    responses: {
        200: jsonResponse(z.null(), 'AT Protocol identity disconnected'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(disconnectRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    await userService.disconnectAtproto(uid);
    return c.json({ success: true as const, data: null }, 200);
});

export { app as atprotoRoute };
