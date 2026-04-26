import { Hono } from 'hono';
import { z } from 'zod';
import {
    CreateOrgRequestSchema,
    UpdateOrgRequestSchema,
    UpdateMemberRoleRequestSchema,
    CreateOrgInviteRequestSchema,
} from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import {
    organizationService,
    promptService,
    hydrationService,
} from '../services/core-services-firebase.js';
import { getAdminDb } from '../lib/firebase-admin.js';

/**
 * Auth-gated reads on `/api/v1/organizations/:orgId`. Every endpoint here
 * requires the viewer to be a member of the org (or admin+) — enforced via
 * `organizationService.assertOrgRole` / `isMember`. Mounts at
 * `/api/v1/organizations` so the slug variants (`/slug/:slug*`) already
 * registered on other routes continue to match under their own prefix.
 *
 * Endpoints:
 *   GET /:orgId            — full OrganizationView (membership required)
 *   GET /:orgId/members    — hydrated member list (membership required)
 *   GET /:orgId/prompts    — prompts in org context, cursor-paginated
 *                            (membership required)
 *
 * Parity with:
 *   apps/web/src/app/api/v1/organizations/[orgId]/route.ts
 *   apps/web/src/app/api/v1/organizations/[orgId]/members/route.ts
 *   apps/web/src/app/api/v1/organizations/[orgId]/prompts/route.ts
 */

const PromptsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
    publicOnly: z.preprocess((v) => v === 'true', z.boolean()).default(false),
});

const app = new Hono();

app.get('/:orgId', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');

    // Membership check. `assertOrgRole` throws a plain `Error('Insufficient
    // permissions')` when the viewer isn't in the allowed-roles set —
    // which surfaces as a 500 via the error-handler's "unknown" branch
    // (intentional parity with apps/web today). Tightening to 403 requires
    // a shared `ForbiddenError` type in shared/errors exported across both
    // tiers — flagged as a follow-up in the PR description.
    await organizationService.assertOrgRole(orgId, uid, ['owner', 'admin', 'member']);

    const orgView = await organizationService.getOrganization(orgId, uid);
    if (!orgView) {
        return c.json(
            {
                status: 'error',
                message: 'Not found',
                requestId: c.get('requestId'),
            },
            404,
        );
    }

    return c.json({ success: true, data: orgView });
});

app.get('/:orgId/members', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');

    await organizationService.assertOrgRole(orgId, uid, ['owner', 'admin', 'member']);

    // No pagination — mirrors apps/web's parity route. Acceptable today
    // because orgs are solo-tenant-sized; when multi-tenant orgs with
    // > 100 members land, lift a `limit`/`cursor` parameter through to
    // `listMembers` in both tiers at once.
    const members = await organizationService.getMembers(orgId);
    return c.json({ success: true, data: members });
});

app.get('/:orgId/prompts', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');

    const isMember = await organizationService.isMember(orgId, uid);
    if (!isMember) {
        return c.json(
            { success: false, error: 'Not a member of this organization' },
            403,
        );
    }

    const parsed = PromptsQuerySchema.safeParse({
        limit: c.req.query('limit') ?? undefined,
        cursor: c.req.query('cursor') ?? undefined,
        publicOnly: c.req.query('publicOnly') ?? undefined,
    });
    if (!parsed.success) {
        return c.json(
            { success: false, error: 'Invalid query parameters', issues: parsed.error.issues },
            400,
        );
    }
    const { limit, cursor, publicOnly } = parsed.data;

    const prompts = await promptService.getPromptsForOrgContext(orgId, limit, cursor, publicOnly);

    return c.json({
        success: true,
        data: prompts,
        nextCursor:
            prompts.length > 0 && prompts.length === limit
                ? prompts[prompts.length - 1].record.id
                : null,
    });
});

// ---------------------------------------------------------------------------
// Writes (Batch A6)
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/organizations
 *
 * Creates a new organization. Slug uniqueness is validated against BOTH
 * the `organizations` collection AND the `handles` collection so a user
 * and an org can't share a name.
 */
app.post('/', requireAuth(), rateLimit(RATE_LIMITS.sensitive), async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            {
                status: 'error',
                message: 'Invalid JSON body',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const validation = CreateOrgRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid data',
                issues: validation.error.issues,
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const data = validation.data;

    const existing = await organizationService.getOrganizationBySlug(data.slug);
    if (existing) {
        return c.json(
            {
                status: 'error',
                message: 'Handle already taken',
                requestId: c.get('requestId'),
            },
            409,
        );
    }

    // Cross-check against user handles. Same reason as POST /handles/claim:
    // the @<name> space is shared between users and orgs.
    const handleDoc = await getAdminDb().collection('handles').doc(data.slug).get();
    if (handleDoc.exists) {
        return c.json(
            {
                status: 'error',
                message: 'Handle already taken',
                requestId: c.get('requestId'),
            },
            409,
        );
    }

    const orgRecord = await organizationService.createOrganization(uid, data);
    const orgView = await hydrationService.hydrateOrganization(orgRecord, 'owner');

    return c.json({ success: true, data: orgView });
});

/**
 * PATCH /api/v1/organizations/:orgId
 *
 * Partial update — admin+ only. Slug changes pass a uniqueness check
 * (against other orgs; user-handle shadowing is not re-checked here
 * because slug renames are rare and covered by the initial POST check).
 */
app.patch('/:orgId', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');

    await organizationService.assertOrgRole(orgId, uid, ['owner', 'admin']);

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            {
                status: 'error',
                message: 'Invalid JSON body',
                requestId: c.get('requestId'),
            },
            400,
        );
    }
    const validation = UpdateOrgRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid data',
                issues: validation.error.issues,
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    if (validation.data.slug) {
        const existing = await organizationService.getOrganizationBySlug(validation.data.slug);
        if (existing && existing.record.id !== orgId) {
            return c.json(
                {
                    status: 'error',
                    message: 'Slug already taken',
                    requestId: c.get('requestId'),
                },
                409,
            );
        }
        // Cross-check user handles for the same reason as POST /organizations.
        // Races are still possible (handle claim between this check and the
        // update), but the POST flow's transactional handle reservation
        // prevents the common case.
        const handleDoc = await getAdminDb()
            .collection('handles')
            .doc(validation.data.slug)
            .get();
        if (handleDoc.exists) {
            return c.json(
                {
                    status: 'error',
                    message: 'Slug already taken',
                    requestId: c.get('requestId'),
                },
                409,
            );
        }
    }

    const updated = await organizationService.updateOrganization(orgId, validation.data);
    return c.json({ success: true, data: updated });
});

/**
 * POST /api/v1/organizations/:orgId/invites
 *
 * Create an invite. Admin+ only. Invite expires in 7 days per
 * OrganizationService.createInvite.
 */
app.post(
    '/:orgId/invites',
    requireAuth(),
    rateLimit(RATE_LIMITS.write),
    async (c) => {
        const uid = c.get('viewerUid')!;
        const orgId = c.req.param('orgId');

        await organizationService.assertOrgRole(orgId, uid, ['owner', 'admin']);

        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            return c.json(
                {
                    status: 'error',
                    message: 'Invalid JSON body',
                    requestId: c.get('requestId'),
                },
                400,
            );
        }

        const validation = CreateOrgInviteRequestSchema.safeParse(body);
        if (!validation.success) {
            return c.json(
                {
                    status: 'error',
                    message: 'Invalid data',
                    issues: validation.error.issues,
                    requestId: c.get('requestId'),
                },
                400,
            );
        }

        const inviteRecord = await organizationService.createInvite(orgId, {
            email: validation.data.email,
            role: validation.data.role,
            invitedBy: uid,
        });

        const inviteView = await hydrationService.hydrateInvite(inviteRecord);

        return c.json({ success: true, data: inviteView });
    },
);

/**
 * POST /api/v1/organizations/:orgId/invites/:inviteId
 *
 * Accept an invite. Any authenticated user. Writes membership and
 * flips the invite doc to 'accepted'. Expired invites are refused and
 * marked 'expired' as a side-effect (see OrganizationService.acceptInvite).
 */
app.post(
    '/:orgId/invites/:inviteId',
    requireAuth(),
    rateLimit(RATE_LIMITS.write),
    async (c) => {
        const uid = c.get('viewerUid')!;
        const orgId = c.req.param('orgId');
        const inviteId = c.req.param('inviteId');

        const member = await organizationService.acceptInvite(orgId, inviteId, uid);
        return c.json({ success: true, data: member });
    },
);

/**
 * POST /api/v1/organizations/:orgId/members
 *
 * Direct add — admin+ only. The invite-flow path is `/invites` →
 * `/invites/:inviteId` (accept). This bypass is for cases like admin
 * adding a known user without an email round-trip.
 */
const AddMemberSchema = z.object({
    userId: z.string().min(1, 'userId is required'),
    role: z.enum(['admin', 'member'], { message: 'role must be admin or member' }),
});

app.post('/:orgId/members', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');

    await organizationService.assertOrgRole(orgId, uid, ['owner', 'admin']);

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            { status: 'error', message: 'Invalid JSON body', requestId: c.get('requestId') },
            400,
        );
    }
    const validation = AddMemberSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Validation error',
                issues: validation.error.issues,
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const { userId, role } = validation.data;
    const member = await organizationService.addMember(orgId, userId, role, uid);
    return c.json({ success: true, data: member });
});

/**
 * PATCH /api/v1/organizations/:orgId/members/:userId
 *
 * Update a member's role. Admin+ only. The service throws on
 * "Cannot change owner role" — surfaces as a 500 today (parity).
 */
app.patch(
    '/:orgId/members/:userId',
    requireAuth(),
    rateLimit(RATE_LIMITS.write),
    async (c) => {
        const uid = c.get('viewerUid')!;
        const orgId = c.req.param('orgId');
        const targetUserId = c.req.param('userId');

        await organizationService.assertOrgRole(orgId, uid, ['owner', 'admin']);

        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            return c.json(
                {
                    status: 'error',
                    message: 'Invalid JSON body',
                    requestId: c.get('requestId'),
                },
                400,
            );
        }
        const validation = UpdateMemberRoleRequestSchema.safeParse(body);
        if (!validation.success) {
            return c.json(
                {
                    status: 'error',
                    message: 'Invalid data',
                    issues: validation.error.issues,
                    requestId: c.get('requestId'),
                },
                400,
            );
        }

        await organizationService.updateMemberRole(orgId, targetUserId, validation.data.role);
        return c.json({ success: true });
    },
);

/**
 * DELETE /api/v1/organizations/:orgId/members/:userId
 *
 * Remove a member. Users can remove themselves (leave); admin+ can
 * remove others. Owners can't be removed (service throws).
 */
app.delete(
    '/:orgId/members/:userId',
    requireAuth(),
    rateLimit(RATE_LIMITS.write),
    async (c) => {
        const uid = c.get('viewerUid')!;
        const orgId = c.req.param('orgId');
        const targetUserId = c.req.param('userId');

        const isSelf = uid === targetUserId;
        if (!isSelf) {
            await organizationService.assertOrgRole(orgId, uid, ['owner', 'admin']);
        } else {
            // Self-leave: verify the caller is actually a member.
            await organizationService.assertOrgRole(orgId, uid, ['owner', 'admin', 'member']);
        }

        await organizationService.removeMember(orgId, targetUserId);
        return c.json({ success: true });
    },
);

export { app as organizationsRoute };
