import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {
    ConnectorConfigRecordSchema,
    ConnectorStatusSchema,
    ConnectorTypeSchema,
} from 'shared/types/records';
import { ConnectorConfigInputSchema, ConnectorConfigUpdateSchema } from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { connectorConfigService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * Connector control-plane endpoints mounted at `/api/v1/connectors` (Plan B).
 *
 *   GET    /{connectorType}/config   — read the viewer's config (404 if unset).
 *   PUT    /{connectorType}/config   — create/replace the config.
 *   PATCH  /{connectorType}/config   — partial update.
 *   GET    /{connectorType}/status   — read connector-reported status.
 *   POST   /{connectorType}/enable   — enable the connector.
 *   POST   /{connectorType}/disable  — disable the connector.
 *
 * The uniform control plane: one contract for every connector's per-owner
 * settings, keyed by `connectorType` (an allowlist — an unknown type fails the
 * param validation with 400). Core owns the envelope (ownership, enabled,
 * status, timestamps) and treats `settings` as an opaque, connector-validated
 * blob. Secrets are never stored — `secretRef` points into a secret store.
 *
 * User-scoped: every route operates on the authenticated viewer's own config.
 * Cross-user system-auth lookups (e.g. telephony's SIP reverse-index) are an
 * ingestion-plane concern and live elsewhere, not on this primitive.
 *
 * See `specs/plan-b-connector-boundaries.md`.
 */

const ConnectorTypeParam = z.object({
    connectorType: ConnectorTypeSchema.openapi({
        param: { name: 'connectorType', in: 'path' },
        example: 'telephony',
        description: 'The connector to configure (allowlisted; unknown types 400).',
    }),
});

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

// ---------------------------------------------------------------------------
// GET /{connectorType}/config — read config
// ---------------------------------------------------------------------------

const getConfigRoute = createRoute({
    method: 'get',
    path: '/{connectorType}/config',
    tags: ['Connectors'],
    summary: 'Get the viewer\'s connector config',
    description: 'Returns the authenticated viewer\'s `ConnectorConfigRecord` for the connector, or 404 if none is set.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: { params: ConnectorTypeParam },
    responses: {
        200: jsonResponse(ConnectorConfigRecordSchema, 'The connector config'),
        401: errorResponse('Not authenticated'),
        404: errorResponse('No config for this connector'),
    },
});

app.openapi(getConfigRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { connectorType } = c.req.valid('param');
    const config = await connectorConfigService.getConfig(uid, connectorType);
    if (!config) {
        return c.json(errorEnvelope(c, 'No config for this connector'), 404);
    }
    return c.json({ success: true as const, data: config }, 200);
});

// ---------------------------------------------------------------------------
// PUT /{connectorType}/config — create or replace
// ---------------------------------------------------------------------------

const putConfigRoute = createRoute({
    method: 'put',
    path: '/{connectorType}/config',
    tags: ['Connectors'],
    summary: 'Create or replace the viewer\'s connector config',
    description: 'Idempotent full write of the config envelope. `settings` is an opaque, connector-specific blob; `secretRef` references a secret store (never a raw secret). Server stamps `createdAt`/`updatedAt`.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        params: ConnectorTypeParam,
        body: { content: { 'application/json': { schema: ConnectorConfigInputSchema } } },
    },
    responses: {
        200: jsonResponse(ConnectorConfigRecordSchema, 'The saved config'),
        400: errorResponse('Invalid request'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(putConfigRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { connectorType } = c.req.valid('param');
    const input = c.req.valid('json');
    const saved = await connectorConfigService.saveConfig(uid, connectorType, input);
    return c.json({ success: true as const, data: saved }, 200);
});

// ---------------------------------------------------------------------------
// PATCH /{connectorType}/config — partial update
// ---------------------------------------------------------------------------

const patchConfigRoute = createRoute({
    method: 'patch',
    path: '/{connectorType}/config',
    tags: ['Connectors'],
    summary: 'Partially update the viewer\'s connector config',
    description: 'Merge-update config fields (`settings`, `secretRef`, `enabled`, `status`). 404 if no config exists yet.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        params: ConnectorTypeParam,
        body: { content: { 'application/json': { schema: ConnectorConfigUpdateSchema } } },
    },
    responses: {
        200: jsonResponse(ConnectorConfigRecordSchema, 'The updated config'),
        400: errorResponse('Invalid request'),
        401: errorResponse('Not authenticated'),
        404: errorResponse('No config for this connector'),
    },
});

app.openapi(patchConfigRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { connectorType } = c.req.valid('param');
    const updates = c.req.valid('json');
    // NotFoundError (no config) is mapped to 404 by the error handler.
    const updated = await connectorConfigService.updateConfig(uid, connectorType, updates);
    return c.json({ success: true as const, data: updated }, 200);
});

// ---------------------------------------------------------------------------
// DELETE /{connectorType}/config — remove config
// ---------------------------------------------------------------------------

const deleteConfigRoute = createRoute({
    method: 'delete',
    path: '/{connectorType}/config',
    tags: ['Connectors'],
    summary: 'Delete the viewer\'s connector config',
    description: 'Removes the config record. Idempotent — succeeds even if none exists. Any connector-side teardown (e.g. releasing a provisioned resource) is the connector\'s responsibility before calling this.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: { params: ConnectorTypeParam },
    responses: {
        200: jsonResponse(z.null(), 'Config deleted'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(deleteConfigRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { connectorType } = c.req.valid('param');
    await connectorConfigService.deleteConfig(uid, connectorType);
    return c.json({ success: true as const, data: null }, 200);
});

// ---------------------------------------------------------------------------
// GET /{connectorType}/status — read status
// ---------------------------------------------------------------------------

const getStatusRoute = createRoute({
    method: 'get',
    path: '/{connectorType}/status',
    tags: ['Connectors'],
    summary: 'Get the connector\'s status',
    description: 'Returns the connector-reported `status` for the viewer\'s config, or 404 if none is set.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: { params: ConnectorTypeParam },
    responses: {
        200: jsonResponse(ConnectorStatusSchema, 'The connector status'),
        401: errorResponse('Not authenticated'),
        404: errorResponse('No config for this connector'),
    },
});

app.openapi(getStatusRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { connectorType } = c.req.valid('param');
    const status = await connectorConfigService.getStatus(uid, connectorType);
    if (!status) {
        return c.json(errorEnvelope(c, 'No config for this connector'), 404);
    }
    return c.json({ success: true as const, data: status }, 200);
});

// ---------------------------------------------------------------------------
// POST /{connectorType}/enable | /disable
// ---------------------------------------------------------------------------

function makeToggleRoute(action: 'enable' | 'disable') {
    return createRoute({
        method: 'post',
        path: `/{connectorType}/${action}`,
        tags: ['Connectors'],
        summary: `${action === 'enable' ? 'Enable' : 'Disable'} the connector`,
        description: `Flip the viewer's connector \`enabled\` flag to \`${action === 'enable'}\`. 404 if no config exists yet.`,
        middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
        request: { params: ConnectorTypeParam },
        responses: {
            200: jsonResponse(ConnectorConfigRecordSchema, 'The updated config'),
            401: errorResponse('Not authenticated'),
            404: errorResponse('No config for this connector'),
        },
    });
}

app.openapi(makeToggleRoute('enable'), async (c) => {
    const uid = c.get('viewerUid')!;
    const { connectorType } = c.req.valid('param');
    const updated = await connectorConfigService.setEnabled(uid, connectorType, true);
    return c.json({ success: true as const, data: updated }, 200);
});

app.openapi(makeToggleRoute('disable'), async (c) => {
    const uid = c.get('viewerUid')!;
    const { connectorType } = c.req.valid('param');
    const updated = await connectorConfigService.setEnabled(uid, connectorType, false);
    return c.json({ success: true as const, data: updated }, 200);
});

export { app as connectorsRoute };
