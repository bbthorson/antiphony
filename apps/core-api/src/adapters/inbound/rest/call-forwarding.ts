import { Hono } from 'hono';
import {
    CallForwardingConfigInputSchema,
    CallForwardingConfigUpdateSchema,
} from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { callForwardingService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

/**
 * Call-forwarding data endpoints mounted at `/api/v1/users/me/call-forwarding`.
 *
 *   GET    /  — read the viewer's call-forwarding config (404 if not set).
 *   POST   /  — create or replace the config. Idempotent — overwrites if exists.
 *   PATCH  /  — partial update (used by apps/telephony/ for verification state).
 *   DELETE /  — remove the config. Does NOT release any Twilio number — that's
 *               apps/telephony/'s responsibility.
 *
 * Pure data CRUD; no Twilio coupling. The Twilio orchestration
 * (Carrier Insights lookup, dedicated-number provisioning, IVR
 * verification call) lives in the planned `apps/telephony/` tier-2
 * service per `specs/data-separation.md` § 5. apps/telephony/ POSTs
 * the already-Twilio-resolved config to this endpoint and PATCHes
 * verification-state transitions after each call.
 *
 * PR-E1 of the Post-4a roadmap. Future PRs in PR-E: extract
 * apps/telephony/ (E2), move the IVR business logic out of apps/web
 * (E3), retire apps/web's parity routes (E4).
 */

const app = new Hono();

// ---------------------------------------------------------------------------
// GET /api/v1/users/me/call-forwarding
// ---------------------------------------------------------------------------
//
// Returns 200 with the config on success; 404 if the user has never set up
// forwarding. (Distinct from "config is in a failed state" — that's still 200
// with `verificationStatus: 'failed'` in the body.)

app.get('/', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const config = await callForwardingService.getConfig(uid);
    if (!config) {
        return c.json(errorEnvelope(c, 'No call-forwarding config'), 404);
    }
    return c.json({ success: true, data: config });
});

// ---------------------------------------------------------------------------
// POST /api/v1/users/me/call-forwarding — create or replace
// ---------------------------------------------------------------------------
//
// Idempotent overwrite. Callers (apps/telephony/) supply the
// fully-resolved config — already-Twilio-looked-up `lineType`/`carrier`,
// already-provisioned `voxpopNumber`/`twilioNumberSid`, etc. The "do
// not overwrite an active config" guard lives in apps/telephony/'s
// user-facing setup endpoint, not here — letting the data API stay
// dumb.

app.post('/', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = CallForwardingConfigInputSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid request body', { issues: validation.error.issues }),
            400,
        );
    }

    const saved = await callForwardingService.saveConfig(uid, validation.data);
    return c.json({ success: true, data: saved });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/users/me/call-forwarding — partial update
// ---------------------------------------------------------------------------
//
// Used by apps/telephony/ to update verification state
// (`verificationStatus`, `verificationAttempts`, `lastVerificationAt`,
// `failureReason`, `enabled`) after each IVR verification call. Throws
// 404 if no config exists for the viewer.

app.patch('/', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;

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

    // Service throws `NotFoundError` (a `ServiceError` subclass from
    // shared/errors) on missing config; the global errorHandler
    // middleware maps it to 404. Any other error bubbles to 500 the
    // same way.
    const updated = await callForwardingService.updateConfig(uid, validation.data);
    return c.json({ success: true, data: updated });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/users/me/call-forwarding
// ---------------------------------------------------------------------------
//
// Idempotent — no-op if no config exists. Does NOT release any Twilio
// number associated with the config; that's apps/telephony/'s
// responsibility (a Twilio API call, not a data write).

app.delete('/', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    await callForwardingService.deleteConfig(uid);
    return c.json({ success: true, data: null });
});

export { app as callForwardingRoute };
