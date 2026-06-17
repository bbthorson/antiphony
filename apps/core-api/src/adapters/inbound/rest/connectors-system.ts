import { Hono } from 'hono';
import { z } from 'zod';
import { ConnectorStatusSchema, ConnectorTypeSchema } from 'shared/types/records';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireSystemAuth } from '../../../middleware/system-auth.js';
import { connectorConfigService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { NotFoundError } from 'shared/errors';

/**
 * Connector status-report endpoint (ingestion plane) mounted at
 * `/api/v1/system/connectors`.
 *
 *   GET  /{connectorType}/config?ownerId=...  — read an owner's config.
 *   POST /{connectorType}/status              — report status for an owner.
 *
 * **System-auth, NOT user-auth.** `status` is connector-reported and
 * deliberately excluded from the user-facing config write shapes (a user must
 * not be able to fake e.g. a 'verified' state — Plan B / #608 review). The
 * connector itself reports it here as a trusted service, supplying the owner's
 * uid explicitly (it has no user bearer at report time). Parallels the
 * `call-forwarding/by-*` system lookups. See `specs/connector-ingestion-contract.md`.
 *
 * Off the documented public contract by design (plain `Hono`, system-auth).
 */

const ReportStatusSchema = z.object({
    ownerId: z.string().trim().min(1),
    status: ConnectorStatusSchema.partial(),
    // A connector may activate itself on a successful verification (e.g.
    // telephony's SIP verify-callback). Optional; omitted leaves `enabled` as-is.
    enabled: z.boolean().optional(),
});

const app = new Hono();

app.get('/:connectorType/config', requireSystemAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const typeParse = ConnectorTypeSchema.safeParse(c.req.param('connectorType'));
    if (!typeParse.success) {
        return c.json(errorEnvelope(c, 'Unknown connector type'), 400);
    }
    const ownerId = c.req.query('ownerId')?.trim();
    if (!ownerId) {
        return c.json(errorEnvelope(c, 'Missing ownerId query param'), 400);
    }

    const config = await connectorConfigService.getConfig(ownerId, typeParse.data);
    if (!config) {
        return c.json(errorEnvelope(c, 'No config for this connector/owner'), 404);
    }
    return c.json({ success: true, data: config });
});

app.post('/:connectorType/status', requireSystemAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const typeParse = ConnectorTypeSchema.safeParse(c.req.param('connectorType'));
    if (!typeParse.success) {
        return c.json(errorEnvelope(c, 'Unknown connector type'), 400);
    }

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const parsed = ReportStatusSchema.safeParse(body);
    if (!parsed.success) {
        return c.json(errorEnvelope(c, 'Invalid request body', { issues: parsed.error.issues }), 400);
    }

    try {
        const updated = await connectorConfigService.reportStatus(
            parsed.data.ownerId,
            typeParse.data,
            parsed.data.status,
            { enabled: parsed.data.enabled },
        );
        return c.json({ success: true, data: updated });
    } catch (err) {
        if (err instanceof NotFoundError) {
            return c.json(errorEnvelope(c, 'No config for this connector/owner'), 404);
        }
        throw err;
    }
});

export { app as connectorsSystemRoute };
