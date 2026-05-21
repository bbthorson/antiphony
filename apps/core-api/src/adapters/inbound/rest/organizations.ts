import { Hono } from 'hono';
import { z } from 'zod';
import {
    CreateOrgRequestSchema,
    UpdateOrgRequestSchema,
    CreateOrgInviteRequestSchema,
    UpdateMemberRoleRequestSchema,
} from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { optionalAuth, requireAuth } from '../../../middleware/auth.js';
import {
    organizationService,
    promptService,
    feedService,
    hydrationService,
} from '../../outbound/firebase/core-services-firebase.js';

/**
 * Organization endpoints mounted at `/api/v1/organizations`.
 *
 * Reads (PR #411):
 *   GET  /slug/:slug/profile  — public aggregated org-profile-page payload.
 *   GET  /slug/:slug          — resolve org by slug (public, auth-optional).
 *   GET  /:orgId/members      — list org members (requires membership).
 *   GET  /:orgId/prompts      — list org prompts (requires membership).
 *   GET  /:orgId              — get org details (requires membership).
 *
 * Writes (this PR, PR-A of the Post-4a roadmap):
 *   POST   /                              — create org (any authed user).
 *   PATCH  /:orgId                        — update org (admin+).
 *   POST   /:orgId/members                — direct-add a member (admin+).
 *   PATCH  /:orgId/members/:userId        — change a member's role (admin+).
 *   DELETE /:orgId/members/:userId        — remove a member (admin+ or self).
 *   POST   /:orgId/invites                — create an invite (admin+).
 *   POST   /:orgId/invites/:inviteId      — accept an invite (any authed user).
 *
 * Parity sources retired in this PR (the entire apps/web parity files
 * are deleted because their GET halves were strangled in PR #411 and
 * their write halves now live here):
 *   apps/web/src/app/api/v1/organizations/route.ts
 *   apps/web/src/app/api/v1/organizations/[orgId]/route.ts
 *   apps/web/src/app/api/v1/organizations/[orgId]/members/route.ts
 *   apps/web/src/app/api/v1/organizations/[orgId]/members/[userId]/route.ts
 *   apps/web/src/app/api/v1/organizations/[orgId]/invites/route.ts
 *   apps/web/src/app/api/v1/organizations/[orgId]/invites/[inviteId]/route.ts
 *   apps/web/src/app/api/v1/organizations/[orgId]/prompts/route.ts
 *   apps/web/src/app/api/v1/organizations/slug/[slug]/route.ts
 *   apps/web/src/app/api/v1/organizations/slug/[slug]/profile/route.ts
 *
 * Route ordering: more-specific paths first so Hono's parameter matcher
 * doesn't capture a literal segment ("slug") as :orgId.
 */

const PromptsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
    publicOnly: z.preprocess((v) => v === 'true', z.boolean()).default(false),
});

// Direct add-member (admin bypass of the email-invite flow). Kept inline
// rather than promoted to api-codecs because it has no other consumers yet.
const AddMemberSchema = z.object({
    userId: z.string().min(1, 'userId is required'),
    role: z.enum(['admin', 'member'], { message: 'role must be admin or member' }),
});

const app = new Hono();

// ---------------------------------------------------------------------------
// GET /api/v1/organizations/slug/:slug/profile — public aggregated payload
// ---------------------------------------------------------------------------
//
// Returns the org-profile-page composite: org details + public (live) prompts
// in the org context + RSS summary if configured. Public endpoint — no auth.

app.get('/slug/:slug/profile', rateLimit(RATE_LIMITS.read), async (c) => {
    const slug = c.req.param('slug');

    const data = await feedService.getOrgProfileData(slug);
    if (!data) {
        return c.json({ success: false, error: 'Organization not found' }, 404);
    }

    return c.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// GET /api/v1/organizations/slug/:slug — resolve org by slug
// ---------------------------------------------------------------------------
//
// Public endpoint — auth is optional; when present, `currentUserRole` on the
// returned view reflects that user's membership role.

app.get('/slug/:slug', optionalAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const slug = c.req.param('slug');
    const requesterId = c.get('viewerUid');

    const org = await organizationService.getOrganizationBySlug(slug, requesterId ?? undefined);
    if (!org) {
        return c.json({ success: false, error: 'Organization not found' }, 404);
    }

    return c.json({ success: true, data: org });
});

// ---------------------------------------------------------------------------
// GET /api/v1/organizations/:orgId/members — list members
// ---------------------------------------------------------------------------
//
// Requires membership (owner, admin, or member).

app.get('/:orgId/members', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');

    const role = await organizationService.getMemberRole(orgId, uid);
    if (!role) {
        return c.json({ success: false, error: 'Not a member of this organization' }, 403);
    }

    const members = await organizationService.getMembers(orgId);
    return c.json({ success: true, data: members });
});

// ---------------------------------------------------------------------------
// GET /api/v1/organizations/:orgId/prompts — list prompts in org context
// ---------------------------------------------------------------------------
//
// Requires membership. Non-members get 403 (org prompt lists are internal by
// default — the public org-profile aggregated endpoint above exposes the
// "live" subset separately).
//
// Query params:
//   limit (default 20, max 100)
//   cursor (last-seen prompt id)
//   publicOnly=true → restrict to status==live

app.get('/:orgId/prompts', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');

    const isMember = await organizationService.isMember(orgId, uid);
    if (!isMember) {
        return c.json({ success: false, error: 'Not a member of this organization' }, 403);
    }

    const queryResult = PromptsQuerySchema.safeParse({
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
        publicOnly: c.req.query('publicOnly'),
    });
    if (!queryResult.success) {
        return c.json(
            { success: false, error: 'Invalid query parameters', issues: queryResult.error.issues },
            400,
        );
    }
    const { limit, cursor, publicOnly } = queryResult.data;

    const prompts = await promptService.getPromptsForOrgContext(orgId, limit, cursor, publicOnly);

    // Paginated standard shape: nested cursor inside `data` alongside
    // `items`. See envelope-Phase-3.
    return c.json({
        success: true,
        data: {
            items: prompts,
            // Guard against empty results: only compute a cursor when the
            // page is full AND there's at least one prompt.
            nextCursor:
                prompts.length > 0 && prompts.length === limit
                    ? prompts[prompts.length - 1].record.id
                    : null,
        },
    });
});

// ---------------------------------------------------------------------------
// GET /api/v1/organizations/:orgId — org details
// ---------------------------------------------------------------------------
//
// Requires membership (owner, admin, or member).

app.get('/:orgId', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');

    const role = await organizationService.getMemberRole(orgId, uid);
    if (!role) {
        return c.json({ success: false, error: 'Not a member of this organization' }, 403);
    }

    const org = await organizationService.getOrganization(orgId, uid);
    if (!org) {
        return c.json({ success: false, error: 'Organization not found' }, 404);
    }

    return c.json({ success: true, data: org });
});

// ===========================================================================
// Writes (PR-A — Post-4a roadmap, parity with the apps/web routes being
// retired in this PR). All writes require auth; specific permission checks
// per endpoint below.
// ===========================================================================

// ---------------------------------------------------------------------------
// POST /api/v1/organizations — create an organization
// ---------------------------------------------------------------------------
//
// Any authenticated user can create an org; they become the owner. Pre-checks
// the org slug against existing orgs and returns 409. The underlying binding's
// `createOrganizationWithOwner` transaction also reserves a row in the
// `handles` collection inside the same transaction — that closes the race
// against concurrent POST /handles/claim writers. A losing-side race throws
// "Handle already taken" from inside the transaction and bubbles to 500;
// the common case is caught by the cheaper pre-check below.

app.post('/', requireAuth(), rateLimit(RATE_LIMITS.sensitive), async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            { status: 'error', message: 'Invalid JSON body', requestId: c.get('requestId') },
            400,
        );
    }

    const validation = CreateOrgRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid request body',
                issues: validation.error.issues,
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    // Pre-check slug uniqueness against existing orgs. The transactional
    // re-check inside `createOrganizationWithOwner` covers the race.
    const existing = await organizationService.getOrganizationBySlug(validation.data.slug);
    if (existing) {
        return c.json(
            { status: 'error', message: 'Handle already taken', requestId: c.get('requestId') },
            409,
        );
    }

    const record = await organizationService.createOrganization(uid, validation.data);
    const view = await hydrationService.hydrateOrganization(record, 'owner');

    return c.json({ success: true, data: view });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/organizations/:orgId — update an organization
// ---------------------------------------------------------------------------
//
// Admin+ only. Slug rename is collision-checked against other orgs. Race
// against concurrent renames is not bounded — last-writer-wins on the rare
// concurrent slug-rename case (matches apps/web parity).

app.patch('/:orgId', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');

    const role = await organizationService.getMemberRole(orgId, uid);
    if (!role || (role !== 'owner' && role !== 'admin')) {
        return c.json({ success: false, error: 'Insufficient permissions' }, 403);
    }

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            { status: 'error', message: 'Invalid JSON body', requestId: c.get('requestId') },
            400,
        );
    }

    const validation = UpdateOrgRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid request body',
                issues: validation.error.issues,
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    // If slug is being changed, ensure it's not taken by another org.
    if (validation.data.slug) {
        const existing = await organizationService.getOrganizationBySlug(validation.data.slug);
        if (existing && existing.record.id !== orgId) {
            return c.json(
                { status: 'error', message: 'Slug already taken', requestId: c.get('requestId') },
                409,
            );
        }
    }

    const updated = await organizationService.updateOrganization(orgId, validation.data);
    const view = await hydrationService.hydrateOrganization(updated, role);

    return c.json({ success: true, data: view });
});

// ---------------------------------------------------------------------------
// POST /api/v1/organizations/:orgId/members — direct-add a member
// ---------------------------------------------------------------------------
//
// Admin+ only. Bypasses the email-invite flow (used when the caller already
// knows the target's UID, e.g. internal tooling). For invite-based flow,
// use POST /:orgId/invites then POST /:orgId/invites/:inviteId.

app.post('/:orgId/members', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');

    const role = await organizationService.getMemberRole(orgId, uid);
    if (!role || (role !== 'owner' && role !== 'admin')) {
        return c.json({ success: false, error: 'Insufficient permissions' }, 403);
    }

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
                message: 'Invalid request body',
                issues: validation.error.issues,
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const member = await organizationService.addMember(
        orgId,
        validation.data.userId,
        validation.data.role,
        uid,
    );

    return c.json({ success: true, data: member });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/organizations/:orgId/members/:userId — change a member's role
// ---------------------------------------------------------------------------
//
// Admin+ only. Cannot change the owner's role (service-level guard throws).

app.patch('/:orgId/members/:userId', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');
    const targetUserId = c.req.param('userId');

    const role = await organizationService.getMemberRole(orgId, uid);
    if (!role || (role !== 'owner' && role !== 'admin')) {
        return c.json({ success: false, error: 'Insufficient permissions' }, 403);
    }

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            { status: 'error', message: 'Invalid JSON body', requestId: c.get('requestId') },
            400,
        );
    }

    const validation = UpdateMemberRoleRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid request body',
                issues: validation.error.issues,
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    await organizationService.updateMemberRole(orgId, targetUserId, validation.data.role);
    return c.json({ success: true, data: null });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/organizations/:orgId/members/:userId — remove a member
// ---------------------------------------------------------------------------
//
// Self-removal (leave) is allowed for any member. Admin+ can remove others.
// The owner cannot be removed (service-level guard throws).

app.delete('/:orgId/members/:userId', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');
    const targetUserId = c.req.param('userId');

    const callerRole = await organizationService.getMemberRole(orgId, uid);
    if (!callerRole) {
        return c.json({ success: false, error: 'Not a member of this organization' }, 403);
    }

    // Self-leave is OK for any member; otherwise admin+ required.
    const isSelf = uid === targetUserId;
    if (!isSelf && callerRole !== 'owner' && callerRole !== 'admin') {
        return c.json({ success: false, error: 'Insufficient permissions' }, 403);
    }

    await organizationService.removeMember(orgId, targetUserId);
    return c.json({ success: true, data: null });
});

// ---------------------------------------------------------------------------
// POST /api/v1/organizations/:orgId/invites — create an invite
// ---------------------------------------------------------------------------
//
// Admin+ only. 7-day expiry (service-level constant).

app.post('/:orgId/invites', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');

    const role = await organizationService.getMemberRole(orgId, uid);
    if (!role || (role !== 'owner' && role !== 'admin')) {
        return c.json({ success: false, error: 'Insufficient permissions' }, 403);
    }

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            { status: 'error', message: 'Invalid JSON body', requestId: c.get('requestId') },
            400,
        );
    }

    const validation = CreateOrgInviteRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid request body',
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
});

// ---------------------------------------------------------------------------
// POST /api/v1/organizations/:orgId/invites/:inviteId — accept an invite
// ---------------------------------------------------------------------------
//
// Any authenticated user can accept an invite addressed to them. Service
// checks the invite status (pending/expired) and writes the member row.
// Returns the raw `OrganizationMemberRecord` (no hydration — matches the
// apps/web parity behavior).

app.post('/:orgId/invites/:inviteId', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgId = c.req.param('orgId');
    const inviteId = c.req.param('inviteId');

    const member = await organizationService.acceptInvite(orgId, inviteId, uid);
    return c.json({ success: true, data: member });
});

export { app as organizationsRoute };
