import { Hono } from 'hono';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import { organizationService, promptService } from '../services/core-services-firebase.js';

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

export { app as organizationsRoute };
