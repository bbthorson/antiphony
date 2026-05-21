import admin from 'firebase-admin';
import { Hono } from 'hono';
import { SwitchOrgRequestSchema, BadgeResetRequestSchema } from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { organizationService } from '../../outbound/firebase/core-services-firebase.js';
import { getAdminDb, getAdminAuth } from '../../../lib/firebase-admin.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

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

const app = new Hono();

app.post('/switch-org', requireAuth(), rateLimit(RATE_LIMITS.burst), async (c) => {
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
        success: true,
        data: { currentOrg: orgId, orgs: orgsMap },
    });
});

app.post('/badges/read', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
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
    return c.json({ success: true, data: null });
});

export { app as usersActionsRoute };
