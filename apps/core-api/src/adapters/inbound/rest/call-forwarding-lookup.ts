import { Hono } from 'hono';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireSystemAuth } from '../../../middleware/system-auth.js';
import { callForwardingService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

/**
 * SIP-routing reverse-index lookups mounted at `/api/v1/call-forwarding`.
 *
 *   GET   /by-phone?phoneNumber=...     — find uid behind a free-tier
 *                                         inbound phone number.
 *   GET   /by-dedicated?voxpopNumber=...— find uid behind a paid-tier
 *                                         dedicated VoxPop number.
 *
 * **System-auth, NOT user-auth.** A Twilio SIP webhook hitting apps/telephony
 * has no user bearer; it resolves the inbound number → uid here. Caller must
 * present the shared `SYSTEM_AUTH_TOKEN` bearer.
 *
 * Plan B B3': telephony's config now lives on the connector-config primitive
 * (`connector_configs/{uid}/items/telephony`); these lookups query it (see the
 * binding). The former per-user config CRUD (`/users/me/call-forwarding`) and
 * `by-uid` read/patch are retired — telephony reads config and reports status
 * via `/api/v1/connectors/*` and `/api/v1/system/connectors/*`.
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

export { app as callForwardingLookupRoute };
