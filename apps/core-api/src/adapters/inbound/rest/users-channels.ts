import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
    CHANNEL_DESCRIPTORS,
    ChannelsResponseSchema,
    type ChannelDescriptor,
    type ChannelState,
    type ChannelView,
} from 'shared/types/channels';
import { SipEnrichmentSchema, type ConnectorConfigRecord } from 'shared/types/records';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { userService, connectorConfigService } from '../../outbound/firebase/core-services-firebase.js';
import { getAdminDb } from '../../../lib/firebase-admin.js';
import { logger } from '../../../lib/logger.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * Channels read-model — `GET /api/v1/users/me/channels` (Phase 1 of
 * `specs/channels.md`).
 *
 * Projects the scattered per-user channel state into one uniform inbound /
 * outbound list, with no storage migration. Sources, by channel:
 *   - phone               → `telephony` connector envelope (connectorConfigService)
 *   - sip                 → `users/{uid}/enrichment/sip` doc
 *   - bluesky-publishing  → linked Bluesky DID on the profile
 *   - web-capture/rss/embed → always-on (static)
 *   - *-coming-soon       → registered-but-unbuilt (static)
 *
 * Read-only. The control-plane writes (enable/disable/configure) stay on their
 * existing per-channel endpoints until Phase 2 consolidation.
 */

// The per-user inputs the projection needs, gathered once up front.
interface ChannelContext {
    telephony: ConnectorConfigRecord | null;
    hasSip: boolean;
    hasBlueskyIdentity: boolean;
}

/**
 * Resolve a descriptor + per-user context into the dynamic half of a row
 * (`state` / `enabled` / `statusDetail`). The static half is copied from the
 * descriptor by the caller.
 */
function resolveState(
    d: ChannelDescriptor,
    ctx: ChannelContext,
): Pick<ChannelView, 'state' | 'enabled' | 'statusDetail'> {
    if (d.comingSoon) {
        return { state: 'coming-soon', enabled: false, statusDetail: null };
    }
    if (d.alwaysOn) {
        return { state: 'active', enabled: true, statusDetail: null };
    }

    switch (d.type) {
        case 'phone': {
            const cfg = ctx.telephony;
            if (!cfg) return { state: 'unconfigured', enabled: false, statusDetail: null };
            // ConnectorStatus.state is a subset of ChannelState — passthrough.
            // Optional-chain `status` so a legacy/corrupt doc missing the field
            // degrades to 'unconfigured' rather than throwing.
            return {
                state: (cfg.status?.state ?? 'unconfigured') as ChannelState,
                enabled: cfg.enabled,
                statusDetail: cfg.status?.detail ?? null,
            };
        }
        case 'sip':
            return ctx.hasSip
                ? { state: 'active', enabled: true, statusDetail: null }
                : { state: 'unconfigured', enabled: false, statusDetail: null };
        case 'bluesky-publishing':
            // Publishing is usable once an identity is linked. The dependency
            // is surfaced via the descriptor's `dependsOn` hint when unmet.
            return ctx.hasBlueskyIdentity
                ? { state: 'active', enabled: true, statusDetail: null }
                : { state: 'unconfigured', enabled: false, statusDetail: null };
        default:
            // Configurable channel with no resolver yet — render as unconfigured
            // rather than throw, so adding a descriptor can't 500 the endpoint.
            return { state: 'unconfigured', enabled: false, statusDetail: null };
    }
}

function toView(d: ChannelDescriptor, ctx: ChannelContext): ChannelView {
    return {
        type: d.type,
        direction: d.direction,
        label: d.label,
        description: d.description,
        alwaysOn: d.alwaysOn,
        configurable: d.configurable,
        gated: d.gated,
        dependsOn: d.dependsOn,
        ...resolveState(d, ctx),
    };
}

/** Read the telephony connector config; null (→ "unconfigured") on any failure. */
async function readTelephony(uid: string): Promise<ConnectorConfigRecord | null> {
    try {
        return await connectorConfigService.getConfig(uid, 'telephony');
    } catch (err) {
        // Degrade this one channel rather than 500-ing the whole aggregate.
        logger.warn({ err, uid }, '[users/me/channels] telephony connector read failed');
        return null;
    }
}

/** Read `users/{uid}/enrichment/sip`; true when a valid SIP enrichment exists. */
async function readHasSip(uid: string): Promise<boolean> {
    try {
        const snap = await getAdminDb()
            .collection('users')
            .doc(uid)
            .collection('enrichment')
            .doc('sip')
            .get();
        if (!snap.exists) return false;
        return SipEnrichmentSchema.safeParse(snap.data()).success;
    } catch (err) {
        // A read failure on one source must not sink the whole aggregate —
        // degrade that channel to "unconfigured" rather than 500.
        logger.warn({ err, uid }, '[users/me/channels] SIP enrichment read failed');
        return false;
    }
}

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const getChannelsRoute = createRoute({
    method: 'get',
    path: '/',
    tags: ['Users', 'Channels'],
    summary: 'List the viewer\'s inbound & outbound channels',
    description:
        'Uniform read-model over the viewer\'s channel state — the connector ' +
        'envelopes, SIP enrichment, linked Bluesky identity, and always-on web/RSS/embed ' +
        'surfaces — grouped by direction. Read-only (Phase 1 of specs/channels.md).',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    responses: {
        200: jsonResponse(ChannelsResponseSchema, 'The viewer\'s channels, grouped by direction'),
        401: errorResponse('Not authenticated'),
        404: errorResponse('Profile not found'),
    },
});

app.openapi(getChannelsRoute, async (c) => {
    const uid = c.get('viewerUid')!;

    const [profile, telephony, hasSip] = await Promise.all([
        userService.getUserDataByUid(uid),
        readTelephony(uid),
        readHasSip(uid),
    ]);

    if (!profile) {
        return c.json(errorEnvelope(c, 'Profile not found'), 404);
    }

    const ctx: ChannelContext = {
        telephony,
        hasSip,
        hasBlueskyIdentity: Boolean(profile.bluesky?.did),
    };

    const inbound: ChannelView[] = [];
    const outbound: ChannelView[] = [];
    for (const d of CHANNEL_DESCRIPTORS) {
        (d.direction === 'outbound' ? outbound : inbound).push(toView(d, ctx));
    }

    return c.json({ success: true as const, data: { inbound, outbound } }, 200);
});

export { app as usersChannelsRoute };
