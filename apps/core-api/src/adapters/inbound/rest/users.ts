import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { toProfileViewBasic, ProfileViewSchema, ProfileViewBasicSchema } from 'shared/types/views';
import { PublicProfileDtoSchema } from 'shared/types/api';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { optionalAuth } from '../../../middleware/auth.js';
import { userService } from '../../outbound/firebase/core-services-firebase.js';
import { getAdminDb } from '../../../lib/firebase-admin.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * Top-level user endpoints mounted at `/api/v1/users`.
 *
 *   GET /            — public discovery list, paginated by handle cursor.
 *                      Returns `PublicProfileDto[]` + nextCursor.
 *   GET /handles     — every public handle (sitemap enumeration).
 *   GET /:handle     — single profile with owner-aware projection (self
 *                      viewer gets full profile; others get
 *                      `ProfileViewBasic`).
 *
 * OpenAPI metadata declared on every route — first family converted as
 * the toolchain pilot per `specs/drafts/openapi-generation.md`. Handler
 * bodies preserve their existing manual validation; the `createRoute`
 * wrapper is metadata-only here, no `request:` validators yet.
 */

const ListQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).optional(),
});

const ListResponseSchema = z.object({
    items: z.array(PublicProfileDtoSchema),
    nextCursor: z.string().nullable(),
});

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

// ---------------------------------------------------------------------------
// GET /api/v1/users — public user discovery list
// ---------------------------------------------------------------------------

const listRoute = createRoute({
    method: 'get',
    path: '/',
    tags: ['Users'],
    summary: 'List public user profiles',
    description: 'Paginated discovery list of users with a public handle. Cursor-paginated by handle.',
    middleware: [rateLimit(RATE_LIMITS.read)] as const,
    request: {
        query: z.object({
            limit: z.coerce.number().int().min(1).max(50).optional().openapi({ description: '1–50 (default 20)' }),
            cursor: z.string().optional().openapi({ description: 'Pagination cursor — the handle of the last user from the prior page' }),
        }),
    },
    responses: {
        200: jsonResponse(ListResponseSchema, 'Paginated list of public profiles'),
        400: errorResponse('Invalid query parameters'),
    },
});

app.openapi(listRoute, async (c) => {
    const queryResult = ListQuerySchema.safeParse({
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
    });
    if (!queryResult.success) {
        return c.json(
            errorEnvelope(c, 'Invalid query parameters', { issues: queryResult.error.issues }),
            400,
        );
    }
    const { limit, cursor } = queryResult.data;

    const db = getAdminDb();
    let query = db
        .collection('users')
        .where('handle', '!=', null)
        .orderBy('handle')
        .limit(limit + 1); // Fetch one extra to detect if there's a next page.

    if (cursor) {
        query = query.startAfter(cursor);
    }

    const snapshot = await query.get();
    const docs = snapshot.docs;

    const hasMore = docs.length > limit;
    const resultDocs = hasMore ? docs.slice(0, limit) : docs;

    const users = resultDocs.map((doc) => {
        const raw = doc.data();
        const data = { ...raw, id: doc.id };
        const parsed = PublicProfileDtoSchema.safeParse(data);
        if (parsed.success) return parsed.data;
        // Profiles that don't fully validate fall back to a minimal projection.
        // Use String(...) coercion (rather than `as string` casts) on raw
        // Firestore data so a malformed numeric handle/displayName doesn't
        // pass through as a non-string and break frontend string ops.
        return {
            id: doc.id,
            handle: String(raw.handle ?? ''),
            displayName: String(raw.displayName || raw.handle || ''),
            avatarUrl: (raw.avatarUrl || null) as string | null,
            bio: (raw.bio || null) as string | null,
        };
    });

    const lastDoc = hasMore ? resultDocs[resultDocs.length - 1] : undefined;
    const nextCursor = lastDoc ? (lastDoc.data().handle as string) : null;

    // Paginated standard shape: `data.items` is the array, `data.nextCursor`
    // holds the pagination handle. Field name `items` is generic so the same
    // unwrap pattern works across paginated endpoints.
    return c.json({ success: true as const, data: { items: users, nextCursor } }, 200);
});

// ---------------------------------------------------------------------------
// GET /api/v1/users/handles — every public handle (sitemap enumeration)
// ---------------------------------------------------------------------------
//
// Must register BEFORE `/:handle` below so a request to `/users/handles`
// lands on this handler rather than being interpreted as a profile lookup
// for the literal handle "handles".

const handlesRoute = createRoute({
    method: 'get',
    path: '/handles',
    tags: ['Users'],
    summary: 'List every public handle',
    description: 'Returns every claimed handle in the system. Used by the sitemap generator.',
    middleware: [rateLimit(RATE_LIMITS.read)] as const,
    responses: {
        200: jsonResponse(z.array(z.string()), 'Array of public handles'),
    },
});

app.openapi(handlesRoute, async (c) => {
    const handles = await userService.getAllPublicHandles();
    return c.json({ success: true as const, data: handles }, 200);
});

// ---------------------------------------------------------------------------
// GET /api/v1/users/:handle — single profile (owner-aware projection)
// ---------------------------------------------------------------------------

const getByHandleRoute = createRoute({
    method: 'get',
    path: '/{handle}',
    tags: ['Users'],
    summary: 'Get a user profile by handle',
    description: 'Returns the full `ProfileView` when the authenticated viewer is the profile owner; otherwise returns `ProfileViewBasic` (handle, displayName, avatarUrl, bio).',
    middleware: [optionalAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: {
        params: z.object({
            handle: z.string().openapi({ description: 'The user handle (case-insensitive)' }),
        }),
    },
    responses: {
        200: jsonResponse(z.union([ProfileViewSchema, ProfileViewBasicSchema]), 'User profile (owner-aware projection)'),
        404: errorResponse('User not found'),
    },
});

app.openapi(getByHandleRoute, async (c) => {
    const handle = c.req.param('handle');

    const targetUser = await userService.getUserData(handle);
    if (!targetUser) {
        return c.json(errorEnvelope(c, 'User not found'), 404);
    }

    const viewerUid = c.get('viewerUid');
    const isSelf = viewerUid !== null && viewerUid === targetUser.id;

    return c.json({
        success: true as const,
        data: isSelf ? targetUser : toProfileViewBasic(targetUser),
    }, 200);
});

export { app as usersRoute };
