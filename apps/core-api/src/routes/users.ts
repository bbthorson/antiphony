import { Hono } from 'hono';
import { z } from 'zod';
import { toProfileViewBasic } from 'shared/types';
import { PublicProfileDtoSchema } from 'shared/types/api';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { optionalAuth } from '../middleware/auth.js';
import { userService } from '../services/core-services-firebase.js';
import { getAdminDb } from '../lib/firebase-admin.js';

/**
 * Top-level user endpoints mounted at `/api/v1/users`.
 *
 *   GET /            — public discovery list, paginated by handle cursor.
 *                      Returns `PublicProfileDto[]` + nextCursor.
 *   GET /:handle     — single profile with owner-aware projection (self
 *                      viewer gets full profile; others get
 *                      `ProfileViewBasic`).
 *
 * Parity sources:
 *   apps/web/src/app/api/v1/users/route.ts (GET list)
 *   apps/web/src/app/api/v1/users/[handle]/route.ts (GET single)
 */

const ListQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).optional(),
});

const app = new Hono();

// ---------------------------------------------------------------------------
// GET /api/v1/users — public user discovery list
// ---------------------------------------------------------------------------
//
// Direct Firestore query (mirrors apps/web's pattern; no service layer
// in either codebase for this read). Paginated by handle.

app.get('/', rateLimit(RATE_LIMITS.read), async (c) => {
    const queryResult = ListQuerySchema.safeParse({
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
    });
    if (!queryResult.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid query parameters',
                issues: queryResult.error.issues,
                requestId: c.get('requestId'),
            },
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

    return c.json({ users, nextCursor });
});

// ---------------------------------------------------------------------------
// GET /api/v1/users/handles — every public handle (sitemap enumeration)
// ---------------------------------------------------------------------------
//
// Public; rate-limited by IP. Returned shape matches the legacy /handles
// endpoint that this replaces: `{ success: true, data: string[] }`.
//
// Must register BEFORE `/:handle` below so a request to `/users/handles`
// lands on this handler rather than being interpreted as a profile lookup
// for the literal handle "handles".

app.get('/handles', rateLimit(RATE_LIMITS.read), async (c) => {
    const handles = await userService.getAllPublicHandles();
    return c.json({
        success: true,
        data: handles,
    });
});

// ---------------------------------------------------------------------------
// GET /api/v1/users/:handle — single profile (owner-aware projection)
// ---------------------------------------------------------------------------

app.get('/:handle', optionalAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const handle = c.req.param('handle');

    const targetUser = await userService.getUserData(handle);
    if (!targetUser) {
        return c.json({ success: false, error: 'User not found' }, 404);
    }

    const viewerUid = c.get('viewerUid');
    const isSelf = viewerUid !== null && viewerUid === targetUser.id;

    return c.json({
        success: true,
        data: isSelf ? targetUser : toProfileViewBasic(targetUser),
    });
});

export { app as usersRoute };
