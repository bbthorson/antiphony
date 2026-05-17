import { Hono } from 'hono';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { optionalAuth, requireAuth } from '../../../middleware/auth.js';
import {
    organizationService,
    promptService,
    feedService,
} from '../../outbound/firebase/core-services-firebase.js';

/**
 * Organization read endpoints mounted at `/api/v1/organizations`.
 *
 *   GET /slug/:slug/profile  — public aggregated org-profile-page payload.
 *   GET /slug/:slug          — resolve org by slug (public, auth-optional).
 *   GET /:orgId/members      — list org members (requires membership).
 *   GET /:orgId/prompts      — list org prompts (requires membership).
 *   GET /:orgId              — get org details (requires membership).
 *
 * Parity sources:
 *   apps/web/src/app/api/v1/organizations/[orgId]/route.ts (GET)
 *   apps/web/src/app/api/v1/organizations/slug/[slug]/route.ts
 *   apps/web/src/app/api/v1/organizations/slug/[slug]/profile/route.ts
 *   apps/web/src/app/api/v1/organizations/[orgId]/members/route.ts (GET)
 *   apps/web/src/app/api/v1/organizations/[orgId]/prompts/route.ts
 *
 * Route ordering: more-specific paths first so Hono's parameter matcher
 * doesn't capture a literal segment ("slug") as :orgId.
 */

const PromptsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
    publicOnly: z.preprocess((v) => v === 'true', z.boolean()).default(false),
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

    return c.json({
        success: true,
        data: prompts,
        // Guard against empty results: only compute a cursor when the page is
        // full AND there's at least one prompt.
        nextCursor:
            prompts.length > 0 && prompts.length === limit
                ? prompts[prompts.length - 1].record.id
                : null,
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

export { app as organizationsRoute };
