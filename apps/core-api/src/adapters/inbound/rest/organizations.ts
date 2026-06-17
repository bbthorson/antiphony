import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {
    CreateOrgRequestSchema,
    UpdateOrgRequestSchema,
    CreateOrgInviteRequestSchema,
    UpdateMemberRoleRequestSchema,
} from 'shared/api-codecs';
import {
    OrganizationViewSchema,
    OrganizationMemberViewSchema,
    OrgInviteViewSchema,
    OrgProfileDataSchema,
    PromptViewSchema,
} from 'shared/types/views';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { optionalAuth, requireAuth } from '../../../middleware/auth.js';
import {
    organizationService,
    promptService,
    feedService,
    hydrationService,
} from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * Organization endpoints mounted at `/api/v1/organizations`.
 *
 * Instrumented into the public contract (Plan B, B4) — orgs are a core domain
 * primitive: membership, invites, role management, plus a public org-profile
 * projection. Tagged `Organizations`.
 *
 *   GET  /slug/{slug}/profile           — public aggregated org-profile payload.
 *   GET  /slug/{slug}                   — resolve org by slug (auth-optional).
 *   GET  /{orgId}/members               — list members (requires membership).
 *   GET  /{orgId}/prompts               — list org prompts (requires membership).
 *   GET  /{orgId}                       — org details (requires membership).
 *   POST   /                            — create org (any authed user).
 *   PATCH  /{orgId}                     — update org (admin+).
 *   POST   /{orgId}/members             — direct-add a member (admin+).
 *   PATCH  /{orgId}/members/{userId}    — change a member's role (admin+).
 *   DELETE /{orgId}/members/{userId}    — remove a member (admin+ or self).
 *   POST   /{orgId}/invites             — create an invite (admin+).
 *   POST   /{orgId}/invites/{inviteId}  — accept an invite (any authed user).
 *
 * Route ordering: more-specific paths first so the parameter matcher doesn't
 * capture a literal segment ("slug") as {orgId}.
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

const SlugParam = z.object({ slug: z.string().openapi({ param: { name: 'slug', in: 'path' } }) });
const OrgIdParam = z.object({ orgId: z.string().openapi({ param: { name: 'orgId', in: 'path' } }) });
const OrgMemberParams = z.object({
    orgId: z.string().openapi({ param: { name: 'orgId', in: 'path' } }),
    userId: z.string().openapi({ param: { name: 'userId', in: 'path' } }),
});
const OrgInviteParams = z.object({
    orgId: z.string().openapi({ param: { name: 'orgId', in: 'path' } }),
    inviteId: z.string().openapi({ param: { name: 'inviteId', in: 'path' } }),
});

const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
    body: { content: { 'application/json': { schema } } },
});

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

// ---------------------------------------------------------------------------
// GET /slug/{slug}/profile — public aggregated payload
// ---------------------------------------------------------------------------

const getProfileRoute = createRoute({
    method: 'get',
    path: '/slug/{slug}/profile',
    tags: ['Organizations'],
    summary: 'Get the public org-profile payload',
    description: 'Public aggregated payload for the org-profile page: org details, public (live) prompts in the org context, and an RSS summary if configured.',
    middleware: [rateLimit(RATE_LIMITS.read)] as const,
    request: { params: SlugParam },
    responses: {
        200: jsonResponse(OrgProfileDataSchema, 'Org-profile payload'),
        404: errorResponse('Organization not found'),
    },
});

app.openapi(getProfileRoute, async (c) => {
    const { slug } = c.req.valid('param');
    const data = await feedService.getOrgProfileData(slug);
    if (!data) {
        return c.json(errorEnvelope(c, 'Organization not found'), 404);
    }
    return c.json({ success: true as const, data }, 200);
});

// ---------------------------------------------------------------------------
// GET /slug/{slug} — resolve org by slug
// ---------------------------------------------------------------------------

const resolveSlugRoute = createRoute({
    method: 'get',
    path: '/slug/{slug}',
    tags: ['Organizations'],
    summary: 'Resolve an organization by slug',
    description: 'Public — auth optional. When authenticated, `currentUserRole` on the returned view reflects the viewer\'s membership.',
    middleware: [optionalAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: { params: SlugParam },
    responses: {
        200: jsonResponse(OrganizationViewSchema, 'The organization'),
        404: errorResponse('Organization not found'),
    },
});

app.openapi(resolveSlugRoute, async (c) => {
    const { slug } = c.req.valid('param');
    const requesterId = c.get('viewerUid');
    const org = await organizationService.getOrganizationBySlug(slug, requesterId ?? undefined);
    if (!org) {
        return c.json(errorEnvelope(c, 'Organization not found'), 404);
    }
    return c.json({ success: true as const, data: org }, 200);
});

// ---------------------------------------------------------------------------
// GET /{orgId}/members — list members
// ---------------------------------------------------------------------------

const listMembersRoute = createRoute({
    method: 'get',
    path: '/{orgId}/members',
    tags: ['Organizations'],
    summary: 'List organization members',
    description: 'Requires membership (owner, admin, or member).',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: { params: OrgIdParam },
    responses: {
        200: jsonResponse(z.array(OrganizationMemberViewSchema), 'The members'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Not a member of this organization'),
    },
});

app.openapi(listMembersRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { orgId } = c.req.valid('param');
    const role = await organizationService.getMemberRole(orgId, uid);
    if (!role) {
        return c.json(errorEnvelope(c, 'Not a member of this organization'), 403);
    }
    const members = await organizationService.getMembers(orgId);
    return c.json({ success: true as const, data: members }, 200);
});

// ---------------------------------------------------------------------------
// GET /{orgId}/prompts — list prompts in org context
// ---------------------------------------------------------------------------

const PromptsPageSchema = z.object({
    items: z.array(PromptViewSchema),
    nextCursor: z.string().nullable(),
});

const listOrgPromptsRoute = createRoute({
    method: 'get',
    path: '/{orgId}/prompts',
    tags: ['Organizations'],
    summary: 'List prompts in the organization context',
    description: 'Requires membership. Paginated (cursor); `publicOnly=true` restricts to live prompts. Non-members get 403 — the public live subset is on the org-profile projection.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: { params: OrgIdParam, query: PromptsQuerySchema },
    responses: {
        200: jsonResponse(PromptsPageSchema, 'Paginated org prompts'),
        400: errorResponse('Invalid query parameters'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Not a member of this organization'),
    },
});

app.openapi(listOrgPromptsRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { orgId } = c.req.valid('param');

    const isMember = await organizationService.isMember(orgId, uid);
    if (!isMember) {
        return c.json(errorEnvelope(c, 'Not a member of this organization'), 403);
    }

    const { limit, cursor, publicOnly } = c.req.valid('query');
    const prompts = await promptService.getPromptsForOrgContext(orgId, limit, cursor, publicOnly);

    return c.json({
        success: true as const,
        data: {
            items: prompts,
            nextCursor:
                prompts.length > 0 && prompts.length === limit
                    ? prompts[prompts.length - 1].record.id
                    : null,
        },
    }, 200);
});

// ---------------------------------------------------------------------------
// GET /{orgId} — org details
// ---------------------------------------------------------------------------

const getOrgRoute = createRoute({
    method: 'get',
    path: '/{orgId}',
    tags: ['Organizations'],
    summary: 'Get organization details',
    description: 'Requires membership (owner, admin, or member).',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: { params: OrgIdParam },
    responses: {
        200: jsonResponse(OrganizationViewSchema, 'The organization'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Not a member of this organization'),
        404: errorResponse('Organization not found'),
    },
});

app.openapi(getOrgRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { orgId } = c.req.valid('param');
    const role = await organizationService.getMemberRole(orgId, uid);
    if (!role) {
        return c.json(errorEnvelope(c, 'Not a member of this organization'), 403);
    }
    const org = await organizationService.getOrganization(orgId, uid);
    if (!org) {
        return c.json(errorEnvelope(c, 'Organization not found'), 404);
    }
    return c.json({ success: true as const, data: org }, 200);
});

// ---------------------------------------------------------------------------
// POST / — create an organization
// ---------------------------------------------------------------------------

const createOrgRoute = createRoute({
    method: 'post',
    path: '/',
    tags: ['Organizations'],
    summary: 'Create an organization',
    description: 'Any authenticated user can create an org and becomes its owner. The slug is reserved transactionally; a collision returns 409.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.sensitive)] as const,
    request: jsonBody(CreateOrgRequestSchema),
    responses: {
        200: jsonResponse(OrganizationViewSchema, 'The created organization'),
        400: errorResponse('Invalid request body'),
        401: errorResponse('Not authenticated'),
        409: errorResponse('Handle already taken'),
    },
});

app.openapi(createOrgRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const input = c.req.valid('json');

    const existing = await organizationService.getOrganizationBySlug(input.slug);
    if (existing) {
        return c.json(errorEnvelope(c, 'Handle already taken'), 409);
    }

    const record = await organizationService.createOrganization(uid, input);
    const view = await hydrationService.hydrateOrganization(record, 'owner');
    return c.json({ success: true as const, data: view }, 200);
});

// ---------------------------------------------------------------------------
// PATCH /{orgId} — update an organization
// ---------------------------------------------------------------------------

const updateOrgRoute = createRoute({
    method: 'patch',
    path: '/{orgId}',
    tags: ['Organizations'],
    summary: 'Update an organization',
    description: 'Admin+ only. A slug rename is collision-checked against other orgs (409 on conflict).',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: { params: OrgIdParam, ...jsonBody(UpdateOrgRequestSchema) },
    responses: {
        200: jsonResponse(OrganizationViewSchema, 'The updated organization'),
        400: errorResponse('Invalid request body'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Insufficient permissions'),
        409: errorResponse('Slug already taken'),
    },
});

app.openapi(updateOrgRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { orgId } = c.req.valid('param');

    const role = await organizationService.getMemberRole(orgId, uid);
    if (!role || (role !== 'owner' && role !== 'admin')) {
        return c.json(errorEnvelope(c, 'Insufficient permissions'), 403);
    }

    const input = c.req.valid('json');
    if (input.slug) {
        const existing = await organizationService.getOrganizationBySlug(input.slug);
        if (existing && existing.record.id !== orgId) {
            return c.json(errorEnvelope(c, 'Slug already taken'), 409);
        }
    }

    const updated = await organizationService.updateOrganization(orgId, input);
    const view = await hydrationService.hydrateOrganization(updated, role);
    return c.json({ success: true as const, data: view }, 200);
});

// ---------------------------------------------------------------------------
// POST /{orgId}/members — direct-add a member
// ---------------------------------------------------------------------------

const addMemberRoute = createRoute({
    method: 'post',
    path: '/{orgId}/members',
    tags: ['Organizations'],
    summary: 'Directly add a member',
    description: 'Admin+ only. Bypasses the email-invite flow (caller already knows the target UID).',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: { params: OrgIdParam, ...jsonBody(AddMemberSchema) },
    responses: {
        200: jsonResponse(z.record(z.unknown()), 'The added member'),
        400: errorResponse('Invalid request body'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Insufficient permissions'),
    },
});

app.openapi(addMemberRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { orgId } = c.req.valid('param');

    const role = await organizationService.getMemberRole(orgId, uid);
    if (!role || (role !== 'owner' && role !== 'admin')) {
        return c.json(errorEnvelope(c, 'Insufficient permissions'), 403);
    }

    const input = c.req.valid('json');
    const member = await organizationService.addMember(orgId, input.userId, input.role, uid);
    return c.json({ success: true as const, data: member }, 200);
});

// ---------------------------------------------------------------------------
// PATCH /{orgId}/members/{userId} — change a member's role
// ---------------------------------------------------------------------------

const updateMemberRoleRoute = createRoute({
    method: 'patch',
    path: '/{orgId}/members/{userId}',
    tags: ['Organizations'],
    summary: 'Change a member\'s role',
    description: 'Admin+ only. The owner\'s role cannot be changed.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: { params: OrgMemberParams, ...jsonBody(UpdateMemberRoleRequestSchema) },
    responses: {
        200: jsonResponse(z.null(), 'Role updated'),
        400: errorResponse('Invalid request body'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Insufficient permissions'),
    },
});

app.openapi(updateMemberRoleRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { orgId, userId } = c.req.valid('param');

    const role = await organizationService.getMemberRole(orgId, uid);
    if (!role || (role !== 'owner' && role !== 'admin')) {
        return c.json(errorEnvelope(c, 'Insufficient permissions'), 403);
    }

    const input = c.req.valid('json');
    await organizationService.updateMemberRole(orgId, userId, input.role);
    return c.json({ success: true as const, data: null }, 200);
});

// ---------------------------------------------------------------------------
// DELETE /{orgId}/members/{userId} — remove a member
// ---------------------------------------------------------------------------

const removeMemberRoute = createRoute({
    method: 'delete',
    path: '/{orgId}/members/{userId}',
    tags: ['Organizations'],
    summary: 'Remove a member',
    description: 'Self-removal (leave) is allowed for any member; admin+ can remove others. The owner cannot be removed.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: { params: OrgMemberParams },
    responses: {
        200: jsonResponse(z.null(), 'Member removed'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Insufficient permissions'),
    },
});

app.openapi(removeMemberRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { orgId, userId } = c.req.valid('param');

    const callerRole = await organizationService.getMemberRole(orgId, uid);
    if (!callerRole) {
        return c.json(errorEnvelope(c, 'Not a member of this organization'), 403);
    }

    const isSelf = uid === userId;
    if (!isSelf && callerRole !== 'owner' && callerRole !== 'admin') {
        return c.json(errorEnvelope(c, 'Insufficient permissions'), 403);
    }

    await organizationService.removeMember(orgId, userId);
    return c.json({ success: true as const, data: null }, 200);
});

// ---------------------------------------------------------------------------
// POST /{orgId}/invites — create an invite
// ---------------------------------------------------------------------------

const createInviteRoute = createRoute({
    method: 'post',
    path: '/{orgId}/invites',
    tags: ['Organizations'],
    summary: 'Create an invite',
    description: 'Admin+ only. 7-day expiry.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: { params: OrgIdParam, ...jsonBody(CreateOrgInviteRequestSchema) },
    responses: {
        200: jsonResponse(OrgInviteViewSchema, 'The created invite'),
        400: errorResponse('Invalid request body'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Insufficient permissions'),
    },
});

app.openapi(createInviteRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { orgId } = c.req.valid('param');

    const role = await organizationService.getMemberRole(orgId, uid);
    if (!role || (role !== 'owner' && role !== 'admin')) {
        return c.json(errorEnvelope(c, 'Insufficient permissions'), 403);
    }

    const input = c.req.valid('json');
    const inviteRecord = await organizationService.createInvite(orgId, {
        email: input.email,
        role: input.role,
        invitedBy: uid,
    });
    const inviteView = await hydrationService.hydrateInvite(inviteRecord);
    return c.json({ success: true as const, data: inviteView }, 200);
});

// ---------------------------------------------------------------------------
// POST /{orgId}/invites/{inviteId} — accept an invite
// ---------------------------------------------------------------------------

const acceptInviteRoute = createRoute({
    method: 'post',
    path: '/{orgId}/invites/{inviteId}',
    tags: ['Organizations'],
    summary: 'Accept an invite',
    description: 'Any authenticated user can accept an invite addressed to them. Returns the new membership.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: { params: OrgInviteParams },
    responses: {
        200: jsonResponse(z.record(z.unknown()), 'The new membership'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(acceptInviteRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { orgId, inviteId } = c.req.valid('param');
    const member = await organizationService.acceptInvite(orgId, inviteId, uid);
    return c.json({ success: true as const, data: member }, 200);
});

export { app as organizationsRoute };
