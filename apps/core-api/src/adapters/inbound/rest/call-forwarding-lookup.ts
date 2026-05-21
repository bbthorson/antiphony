import { Hono } from 'hono';
import { z } from 'zod';
import { CallForwardingConfigUpdateSchema } from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireSystemAuth } from '../../../middleware/system-auth.js';
import { callForwardingService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

/**
 * SIP-routing lookup endpoints mounted at `/api/v1/call-forwarding`.
 *
 *   GET   /by-phone?phoneNumber=...     — find uid behind a free-tier
 *                                         inbound phone number.
 *   GET   /by-dedicated?voxpopNumber=...— find uid behind a paid-tier
 *                                         dedicated VoxPop number.
 *   GET   /by-uid/:uid                  — read a specific user's config.
 *   PATCH /by-uid/:uid                  — partial-update a specific
 *                                         user's config (verification
 *                                         state from SIP webhooks).
 *
 * **All require system-auth, NOT user-auth.** They expose data across
 * users (a Twilio SIP webhook hitting apps/telephony doesn't have a
 * user bearer; the verify-callback flow knows the uid from the URL
 * query echoed back by Twilio, but has no end-user authentication).
 * Caller must present the shared `SYSTEM_AUTH_TOKEN` bearer.
 *
 * The user-bearer variants of get/patch live in `call-forwarding.ts`
 * (mounted at `/api/v1/users/me/call-forwarding`) — same service-side
 * methods, different auth.
 *
 * PR-E3 of the Post-4a roadmap. The matching service-side methods
 * live in packages/core/services/call-forwarding.ts.
 */

const PhoneQuerySchema = z.object({
    phoneNumber: z.string().min(1),
});

const DedicatedQuerySchema = z.object({
    voxpopNumber: z.string().min(1),
});

const app = new Hono();

app.get('/by-phone', requireSystemAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const parsed = PhoneQuerySchema.safeParse({
        phoneNumber: c.req.query('phoneNumber'),
    });
    if (!parsed.success) {
        return c.json(errorEnvelope(c, 'Missing or invalid phoneNumber query param'), 400);
    }

    const uid = await callForwardingService.findUidByPhoneNumber(parsed.data.phoneNumber);
    if (!uid) {
        return c.json(errorEnvelope(c, 'No matching forwarding config'), 404);
    }

    return c.json({ success: true, data: { uid } });
});

app.get('/by-dedicated', requireSystemAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const parsed = DedicatedQuerySchema.safeParse({
        voxpopNumber: c.req.query('voxpopNumber'),
    });
    if (!parsed.success) {
        return c.json(errorEnvelope(c, 'Missing or invalid voxpopNumber query param'), 400);
    }

    const uid = await callForwardingService.findUidByDedicatedNumber(parsed.data.voxpopNumber);
    if (!uid) {
        return c.json(errorEnvelope(c, 'No matching dedicated-number config'), 404);
    }

    return c.json({ success: true, data: { uid } });
});

app.get('/by-uid/:uid', requireSystemAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.req.param('uid');
    if (!uid) {
        return c.json(errorEnvelope(c, 'Missing uid path param'), 400);
    }

    const config = await callForwardingService.getConfig(uid);
    if (!config) {
        return c.json(errorEnvelope(c, 'No call-forwarding config'), 404);
    }

    return c.json({ success: true, data: config });
});

app.patch('/by-uid/:uid', requireSystemAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.req.param('uid');
    if (!uid) {
        return c.json(errorEnvelope(c, 'Missing uid path param'), 400);
    }

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = CallForwardingConfigUpdateSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid request body', { issues: validation.error.issues }),
            400,
        );
    }

    const updated = await callForwardingService.updateConfig(uid, validation.data);
    return c.json({ success: true, data: updated });
});

export { app as callForwardingLookupRoute };
