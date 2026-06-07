import { Hono } from 'hono';
import { ScreeningRuleInputSchema, ScreeningRuleUpdateSchema } from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { screeningService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

/**
 * Screening-allowlist CRUD, mounted at `/api/v1/users/me/screening`.
 *
 *   GET    /            — list the viewer's rules (newest first).
 *   POST   /            — create a manual rule.
 *   PATCH  /:ruleId     — partial update (label / action / e164 / expiresAt).
 *   DELETE /:ruleId     — remove a rule.
 *
 * Canonical user-authored config (tier 1) — like call-forwarding. Phase-1
 * stores + edits rules; the ring-through-vs-async *evaluation* is Phase-2
 * capture-all behavior in apps/telephony. See `specs/consumer-call-app.md` § 5.
 * This feature ships ungated; the paid gate lands in the pre-beta consolidation
 * pass (`docs/feature-gates.md`).
 */

const app = new Hono();

app.get('/', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const rules = await screeningService.listRules(uid);
    return c.json({ success: true, data: rules });
});

app.post('/', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = ScreeningRuleInputSchema.safeParse(body);
    if (!validation.success) {
        return c.json(errorEnvelope(c, 'Invalid request body', { issues: validation.error.issues }), 400);
    }

    const rule = await screeningService.createRule(uid, validation.data);
    return c.json({ success: true, data: rule });
});

app.patch('/:ruleId', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const ruleId = c.req.param('ruleId');

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = ScreeningRuleUpdateSchema.safeParse(body);
    if (!validation.success) {
        return c.json(errorEnvelope(c, 'Invalid request body', { issues: validation.error.issues }), 400);
    }

    // NotFoundError (unknown ruleId) is mapped to 404 by the error handler.
    const rule = await screeningService.updateRule(uid, ruleId, validation.data);
    return c.json({ success: true, data: rule });
});

app.delete('/:ruleId', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const ruleId = c.req.param('ruleId');
    await screeningService.deleteRule(uid, ruleId);
    return c.json({ success: true, data: null });
});

export { app as screeningRoute };
