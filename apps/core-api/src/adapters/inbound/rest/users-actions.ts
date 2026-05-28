import admin from 'firebase-admin';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { SwitchOrgRequestSchema, BadgeResetRequestSchema } from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { organizationService } from '../../outbound/firebase/core-services-firebase.js';
import { getAdminDb, getAdminAuth } from '../../../lib/firebase-admin.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * Viewer-action endpoints mounted at `/api/v1/users`.
 *
 *   POST /switch-org      — switch active org context (custom claim)
 *   POST /badges/read     — reset notification badge counters
 *
 * Mounted BEFORE the `/:handle` catch-all so Hono matches the literal
 * paths first.
 *
 * Parity sources:
 *   apps/web/src/app/api/v1/users/switch-org/route.ts
 *   apps/web/src/app/api/v1/users/badges/read/route.ts
 */

const SwitchOrgResponseSchema = z.object({
    currentOrg: z.string().nullable(),
    orgs: z.record(z.string(), z.string()),
});

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const switchOrgRoute = createRoute({
    method: 'post',
    path: '/switch-org',
    tags: ['Users'],
    summary: 'Switch active organization context',
    description: 'Sets the active-org custom claim for the authenticated viewer. Verifies membership in the target org before granting the claim; re-denormalizes the full org map from membership docs.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.burst)] as const,
    request: {
        body: {
            content: {
                'application/json': { schema: SwitchOrgRequestSchema },
            },
        },
    },
    responses: {
        200: jsonResponse(SwitchOrgResponseSchema, 'New custom-claim state'),
        400: errorResponse('Invalid request body'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Not a member of the target organization'),
    },
});

app.openapi(switchOrgRoute, async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = SwitchOrgRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid data', { issues: validation.error.issues }),
            400,
        );
    }

    const { orgId } = validation.data;
    const adminAuth = getAdminAuth();

    if (orgId) {
        // Verify membership before granting the active-org claim.
        const role = await organizationService.getMemberRole(orgId, uid);
        if (!role) {
            return c.json(errorEnvelope(c, 'Not a member of this organization'), 403);
        }
    }

    // Re-denormalize the full `orgs` claim map from the source-of-truth
    // memberships. Matches apps/web — prevents claims from drifting away
    // from membership docs on repeated org-switch.
    const userOrgs = await organizationService.getUserOrganizations(uid);
    const orgsMap: Record<string, string> = {};
    for (const org of userOrgs) {
        if (org.currentUserRole) orgsMap[org.record.id] = org.currentUserRole;
    }

    // Preserve non-org claims — the user may have admin flags or other
    // project-specific custom claims set outside this endpoint.
    const existingUser = await adminAuth.getUser(uid);
    const existingClaims = existingUser.customClaims || {};

    await adminAuth.setCustomUserClaims(uid, {
        ...existingClaims,
        currentOrg: orgId,
        orgs: orgsMap,
    });

    return c.json({
        success: true as const,
        data: { currentOrg: orgId, orgs: orgsMap },
    }, 200);
});

const badgesReadRoute = createRoute({
    method: 'post',
    path: '/badges/read',
    tags: ['Users'],
    summary: 'Reset a notification badge counter',
    description: 'Resets the `new_replier` or `unread_reply` badge for the authenticated viewer.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        body: {
            content: {
                'application/json': { schema: BadgeResetRequestSchema },
            },
        },
    },
    responses: {
        200: jsonResponse(z.null(), 'Badge counter reset'),
        400: errorResponse('Invalid type'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(badgesReadRoute, async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = BadgeResetRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(errorEnvelope(c, 'Invalid type'), 400);
    }

    const { type } = validation.data;
    const userRef = getAdminDb().collection('users').doc(uid);

    // Raw Firestore write — mirrors apps/web. No service-layer method for
    // badge resets yet; fine to keep as a route-local pattern for now.
    if (type === 'new_replier') {
        await userRef.update({
            newReplierCount: 0,
            lastSeenAt: admin.firestore.Timestamp.now(),
        });
    } else if (type === 'unread_reply') {
        await userRef.update({
            unreadReplyCount: 0,
            lastSeenAt: admin.firestore.Timestamp.now(),
        });
    }

    // Fire-and-forget reset; `data: null` for the standard envelope.
    return c.json({ success: true as const, data: null }, 200);
});

export { app as usersActionsRoute };
