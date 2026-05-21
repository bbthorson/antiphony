import { Hono } from 'hono';
import { z } from 'zod';
import { toReplyViewPublic } from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireSystemAuth } from '../../../middleware/system-auth.js';
import { replyService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

/**
 * System-auth reply creation endpoint mounted at `/api/v1/system/replies`.
 *
 *   POST /                           — create a reply on behalf of `authorUid`.
 *
 * **Requires system-auth, NOT user-auth.** This endpoint is intended for
 * sibling deployables (apps/telephony today, future tier-2 channel
 * services) that capture a reply from a caller for whom they have no
 * Firebase ID token — e.g. a Twilio SIP inbound call resolved to a uid via
 * `/api/v1/call-forwarding/by-phone` followed by a recording upload. The
 * channel service trusts its own ingress (Twilio signature, etc.) and then
 * uses the shared `SYSTEM_AUTH_TOKEN` to drive the canonical write through
 * core-api.
 *
 * The body's `authorUid` is the resolved uid the reply should be attributed
 * to — not the caller's identity (which is the channel service itself).
 *
 * Internally calls `replyService.createReplyTransaction(authorUid, body)`,
 * the same path the user-auth `POST /api/v1/replies` uses. The response
 * shape matches `POST /api/v1/replies` so the call site sees one stable
 * envelope.
 */

const CreateSystemReplyRequestSchema = z.object({
    authorUid: z.string().min(1),
    promptId: z.string().min(1),
    audioUrl: z.string().url(),
});

const app = new Hono();

app.post('/', requireSystemAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = CreateSystemReplyRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid request body', { issues: validation.error.issues }),
            400,
        );
    }

    const { authorUid, promptId, audioUrl } = validation.data;

    const hydratedReply = await replyService.createReplyTransaction(authorUid, {
        promptId,
        audioUrl,
    });

    return c.json({
        success: true,
        data: hydratedReply ? toReplyViewPublic(hydratedReply) : null,
    });
});

export { app as systemRepliesRoute };
