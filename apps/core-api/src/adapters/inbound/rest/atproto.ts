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
 * Only `disconnect` lives here. The OAuth flow endpoints (`authorize`,
 * `callback`, `client-metadata.json`) stay on the product app (the BFF)
 * because the OAuth callback URL is registered with the PDS and tied to
 * that app's origin.
 *
 * OpenAPI scope: `disconnect` is the only client-callable surface here,
 * so it's the only route documented.
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
