import admin from 'firebase-admin';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { ConflictError } from 'shared/errors';
import { UpdateProfileRequestSchema } from 'shared/api-codecs';
import { ProfileViewSelfSchema } from 'shared/types/views';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { userService, organizationService } from '../../outbound/firebase/core-services-firebase.js';
import { firebaseUserDependencies } from '../../outbound/firebase/users-dependencies.js';
import { getAdminDb, getAdminAuth } from '../../../lib/firebase-admin.js';
import { APP_CONFIG } from '../../../lib/app-config.js';
import { logger } from '../../../lib/logger.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * Authenticated-viewer "me" endpoints mounted at `/api/v1/users/me`.
 *
 *   GET    /                       — full profile (PII)
 *   PATCH  /                       — update profile (handle-swap + field merge)
 *   GET    /organizations          — hydrated orgs the viewer belongs to
 *   GET    /handle/available       — check handle availability
 *   POST   /handle                 — claim or re-affirm the viewer's handle
 *   POST   /delete                 — soft-delete (deactivate) account
 *
 * Parity sources:
 *   apps/web/src/app/api/v1/users/me/route.ts (GET + PATCH)
 *   apps/web/src/app/api/v1/users/me/organizations/route.ts (GET)
 *   apps/web/src/app/api/v1/users/me/delete/route.ts (POST)
 */

// Use the canonical shared schema — enforces `handle` min(3) + regex that the
// apps/web legacy local schema missed. Extends with fields the handler accepts
// beyond the shared set (email + rssFeedUrl) — these aren't in the shared
// schema today; lifting them there is a separate cleanup.
const UpdateUserSchema = UpdateProfileRequestSchema.extend({
    email: z.string().email().optional(),
    rssFeedUrl: z.string().url().optional(),
}).partial();

const DeleteSchema = z.object({
    confirm: z.literal(true, { errorMap: () => ({ message: 'Confirmation required' }) }),
});

// Reserved handles that would shadow top-level routes mounted under
// `/api/v1/users/*`. A user claiming `me` or `handles` would, depending on
// route registration order, either hide their own profile lookup or hide the
// sitemap-enumeration endpoint. Block at the validation layer.
const RESERVED_HANDLES = new Set(['me', 'handle', 'handles']);

const ClaimHandleSchema = z.object({
    handle: z
        .string()
        .min(3)
        .max(20)
        .toLowerCase()
        .regex(/^[a-z0-9_]+$/, 'Handle must be alphanumeric')
        .refine((h) => !RESERVED_HANDLES.has(h), {
            message: 'Handle is reserved',
        }),
});

const HandleAvailabilityResponseSchema = z.object({
    available: z.boolean(),
    reason: z.enum(['invalid', 'taken']).optional(),
    owned: z.boolean().optional(),
});

const HandleClaimResponseSchema = z.object({
    handle: z.string(),
    domain: z.string(),
});

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

// ---------------------------------------------------------------------------
// GET /api/v1/users/me — full profile
// ---------------------------------------------------------------------------

const getMeRoute = createRoute({
    method: 'get',
    path: '/',
    tags: ['Users'],
    summary: 'Get the authenticated viewer\'s profile',
    description: 'Returns the full `ProfileViewSelf` (PII-included) for the authenticated viewer.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    responses: {
        200: jsonResponse(ProfileViewSelfSchema, 'Authenticated viewer\'s full profile'),
        401: errorResponse('Not authenticated'),
        404: errorResponse('Profile not found'),
    },
});

app.openapi(getMeRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const profile = await userService.getUserDataByUid(uid);
    if (!profile) {
        return c.json(errorEnvelope(c, 'Profile not found'), 404);
    }
    return c.json({ success: true as const, data: profile }, 200);
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/users/me — update profile
// ---------------------------------------------------------------------------

const patchMeRoute = createRoute({
    method: 'patch',
    path: '/',
    tags: ['Users'],
    summary: 'Update the authenticated viewer\'s profile',
    description: 'Partial-update profile fields (display name, bio, handle, email, rssFeedUrl, etc.). Handle-swap is transactional. Returns `data: null` on success.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        body: {
            content: { 'application/json': { schema: UpdateUserSchema } },
        },
    },
    responses: {
        200: jsonResponse(z.null(), 'Profile updated'),
        400: errorResponse('Invalid request'),
        401: errorResponse('Not authenticated'),
        409: errorResponse('Handle is already taken'),
    },
});

app.openapi(patchMeRoute, async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = UpdateUserSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid request', { issues: validation.error.issues }),
            400,
        );
    }

    const updates = validation.data;
    const cleanUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, v]) => v !== undefined),
    );

    if (Object.keys(cleanUpdates).length === 0) {
        // No-op write — the message text was never read by callers
        // (only logged client-side in dev). `data: null` keeps the
        // response on the standard envelope.
        return c.json({ success: true as const, data: null }, 200);
    }

    try {
        // The binding's updateUserProfile does a transactional handle-swap;
        // goes through the binding because apps/web's parity route calls
        // userService.updateUserProfile which is a thin wrapper. We'd need
        // to add that wrapper to UserService first, which is extra work for
        // zero behavior difference.
        await firebaseUserDependencies.updateUserProfile(uid, cleanUpdates);
    } catch (err) {
        if (err instanceof ConflictError) {
            return c.json(errorEnvelope(c, 'Handle is already taken'), 409);
        }
        throw err;
    }

    // Drop the `updates` echo — caller already knows what it sent, no
    // in-tree reader of this field. `data: null` keeps the standard
    // envelope shape.
    return c.json({ success: true as const, data: null }, 200);
});

// ---------------------------------------------------------------------------
// GET /api/v1/users/me/organizations — hydrated org memberships
// ---------------------------------------------------------------------------

const getOrganizationsRoute = createRoute({
    method: 'get',
    path: '/organizations',
    tags: ['Users'],
    summary: 'List orgs the viewer belongs to',
    description: 'Returns hydrated `OrganizationView[]` for every org the authenticated viewer is a member of.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    responses: {
        200: jsonResponse(z.array(z.unknown()), 'Hydrated org memberships'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(getOrganizationsRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const orgs = await organizationService.getUserOrganizations(uid);
    return c.json({ success: true as const, data: orgs }, 200);
});

// -----------------------------------------------------------------------------
// Handle endpoints — folded in from the deprecated `/api/v1/handles/*` surface.
// The actor (user) owns its handle; the read+write surface for a user's own
// handle naturally lives under /users/me/handle/*.
// -----------------------------------------------------------------------------

/**
 * GET /api/v1/users/me/handle/available?candidate=xyz
 *
 * Handle availability for the authenticated viewer. Returns:
 *   - `{ available: true }` — free
 *   - `{ available: true, owned: true }` — already owned by viewer
 *   - `{ available: false, reason: 'invalid' | 'taken' }` — unusable
 *
 * Auth required so we can flag owned-by-self distinctly from owned-by-other.
 */
const handleAvailableRoute = createRoute({
    method: 'get',
    path: '/handle/available',
    tags: ['Users'],
    summary: 'Check handle availability',
    description: 'Returns whether `candidate` is available, taken by another user, owned by the viewer, or invalid.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: {
        // `candidate` is intentionally optional in the schema — the handler
        // treats a missing or invalid value as `{ available: false,
        // reason: 'invalid' }`, NOT a 400. If we declared it required here,
        // the OpenAPI validator would short-circuit with 400 before the
        // handler runs, breaking that contract.
        query: z.object({
            candidate: z.string().optional().openapi({ description: 'The candidate handle to check' }),
        }),
    },
    responses: {
        200: jsonResponse(HandleAvailabilityResponseSchema, 'Availability verdict'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(handleAvailableRoute, async (c) => {
    const viewerUid = c.get('viewerUid');
    // Reuse ClaimHandleSchema so availability + claim apply identical rules
    // (length, charset, reserved words). Without this the two checks drift —
    // a 25-char candidate would have passed availability but failed at claim.
    const parsed = ClaimHandleSchema.safeParse({ handle: c.req.query('candidate') });
    if (!parsed.success) {
        return c.json({ success: true as const, data: { available: false, reason: 'invalid' as const } }, 200);
    }
    const candidate = parsed.data.handle;

    const ownerUid = await firebaseUserDependencies.resolveHandle(candidate);
    if (!ownerUid) {
        return c.json({ success: true as const, data: { available: true } }, 200);
    }
    if (ownerUid === viewerUid) {
        return c.json({ success: true as const, data: { available: true, owned: true } }, 200);
    }
    return c.json({ success: true as const, data: { available: false, reason: 'taken' as const } }, 200);
});

/**
 * POST /api/v1/users/me/handle
 *
 * Claim or re-affirm the authenticated viewer's handle. Atomic:
 *   - Cross-checks the organizations.slug space (slug != handle conflict)
 *   - Reserves the `handles/{handle}` doc inside a transaction
 *   - Updates the user-doc pointer to the new handle
 *   - Best-effort: ensures membership in the default org after commit
 *
 * Body: `{ handle: string }` (3-20 chars, lowercased, alphanumeric + _).
 *
 * Response: `{ success: true, data: { handle, domain } }` on success;
 * 409 with the standard error envelope on conflict.
 */
const claimHandleRoute = createRoute({
    method: 'post',
    path: '/handle',
    tags: ['Users'],
    summary: 'Claim or re-affirm the viewer\'s handle',
    description: 'Reserves the candidate handle for the authenticated viewer in an atomic transaction. Echoes the claimed handle + app domain on success.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        body: {
            content: { 'application/json': { schema: ClaimHandleSchema } },
        },
    },
    responses: {
        200: jsonResponse(HandleClaimResponseSchema, 'Handle claimed'),
        400: errorResponse('Invalid handle format'),
        401: errorResponse('Not authenticated'),
        409: errorResponse('Handle is already taken'),
    },
});

app.openapi(claimHandleRoute, async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }
    const validation = ClaimHandleSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid handle format', { issues: validation.error.issues }),
            400,
        );
    }

    const { handle } = validation.data;
    const db = getAdminDb();

    try {
        // Pre-transaction: collectionGroup/where queries can't run inside a
        // Firestore Admin SDK transaction, so check the org-slug space here
        // first. Narrow race acceptable — an org getting created with this
        // slug between check and commit is rare.
        const orgQuery = await db
            .collection('organizations')
            .where('slug', '==', handle)
            .limit(1)
            .get();
        if (!orgQuery.empty) {
            throw new Error('Handle is already taken');
        }

        await db.runTransaction(async (t) => {
            const handleRef = db.collection('handles').doc(handle);
            const userRef = db.collection('users').doc(uid);

            // All reads must happen before any writes inside a Firestore
            // transaction. Parallel via Promise.all — two independent docs.
            const [handleDoc, userDoc] = await Promise.all([
                t.get(handleRef),
                t.get(userRef),
            ]);
            const oldHandle = userDoc.data()?.handle as string | undefined;

            if (handleDoc.exists) {
                const ownerUid = handleDoc.data()?.uid;
                if (ownerUid !== uid) {
                    throw new Error('Handle is already taken');
                }
                // Owned by viewer already — skip the handle-doc write so we
                // preserve the original createdAt.
            } else {
                t.set(handleRef, {
                    uid,
                    createdAt: admin.firestore.Timestamp.now(),
                });
            }

            // Rename case: delete the orphaned `handles/{oldHandle}` doc so
            // it can be reclaimed (by this user or another). Pre-fix bug —
            // flagged by Gemini on PR #380 and tracked in
            // `memory/project_handle_rename_orphan_bug.md`. Skip when:
            //   - First claim ever (no prior handle on the user doc).
            //   - No-op affirmation (new handle equals old, e.g. a UI that
            //     re-POSTs on focus).
            if (oldHandle && oldHandle !== handle) {
                t.delete(db.collection('handles').doc(oldHandle));
            }

            t.set(
                userRef,
                {
                    handle,
                    domain: APP_CONFIG.DOMAIN,
                    updatedAt: admin.firestore.Timestamp.now(),
                },
                { merge: true },
            );
        });

        ensureDefaultOrgMembership(uid, c.get('requestId')).catch((err) => {
            logger.error(
                { err, uid, requestId: c.get('requestId') },
                '[users/me/handle] default-org membership failed',
            );
        });

        // Echo the claimed handle + the app domain so clients can construct
        // the public URL without re-fetching. Both kept under `data` for the
        // standard envelope.
        return c.json({ success: true as const, data: { handle, domain: APP_CONFIG.DOMAIN } }, 200);
    } catch (err) {
        if (err instanceof Error && err.message === 'Handle is already taken') {
            return c.json(errorEnvelope(c, 'This handle is taken.'), 409);
        }
        throw err;
    }
});

async function ensureDefaultOrgMembership(userId: string, requestId: string): Promise<void> {
    const db = getAdminDb();
    const orgId = APP_CONFIG.DEFAULT_ORG_ID;
    const orgRef = db.collection('organizations').doc(orgId);
    const memberRef = orgRef.collection('members').doc(userId);

    const memberDoc = await memberRef.get();
    if (memberDoc.exists) return;

    const orgDoc = await orgRef.get();
    if (!orgDoc.exists) {
        await orgRef.set({
            id: orgId,
            name: APP_CONFIG.DEFAULT_ORG_NAME,
            slug: APP_CONFIG.DEFAULT_ORG_SLUG,
            description: `The default ${APP_CONFIG.NAME} community.`,
            ownerId: 'system',
            createdAt: admin.firestore.Timestamp.now(),
            tier: 'free',
            domainVerified: false,
        });
        logger.info(
            { orgId, requestId },
            '[users/me/handle] created default org',
        );
    }

    await memberRef.set({
        orgId,
        userId,
        role: 'member',
        joinedAt: admin.firestore.Timestamp.now(),
    });
}

/**
 * POST /users/me/delete
 *
 * Soft-deletes (deactivates) the authenticated user's account:
 *   - Sets user doc status to 'deactivated' + deactivatedAt stamp
 *   - Releases the handle doc so it can be reclaimed
 *   - Revokes all Firebase Auth refresh tokens (invalidates sessions)
 *
 * Does NOT delete user doc, prompts, replies, or org memberships — the
 * user's content stays intact for recovery / archival purposes.
 *
 * Parity with apps/web's handler, which reaches for getAdminDb / getAdminAuth
 * directly — no equivalent service method exists yet. Keeping the raw
 * pattern here for parity; can tighten into a binding method in a
 * future refactor once apps/web is gone.
 */
const deleteAccountRoute = createRoute({
    method: 'post',
    path: '/delete',
    tags: ['Users'],
    summary: 'Deactivate the viewer\'s account',
    description: 'Soft-deletes (deactivates) the account: marks the user doc, releases the handle, and revokes refresh tokens. Does NOT remove prompts, replies, or org memberships.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        body: {
            content: { 'application/json': { schema: DeleteSchema } },
        },
    },
    responses: {
        200: jsonResponse(z.null(), 'Account deactivated'),
        400: errorResponse('Missing confirmation'),
        401: errorResponse('Not authenticated'),
        500: errorResponse('Internal error'),
    },
});

app.openapi(deleteAccountRoute, async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            errorEnvelope(c, 'Must include { confirm: true } to delete account'),
            400,
        );
    }
    const validation = DeleteSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Must include { confirm: true } to delete account'),
            400,
        );
    }

    try {
        const db = getAdminDb();
        const adminAuth = getAdminAuth();

        // Transaction: user-doc deactivation + handle release. Keeps the
        // two Firestore ops atomic so we can't end up with a deactivated
        // user whose handle is still taken (or vice versa) on partial
        // failure. Auth token revocation runs after — it's not a Firestore
        // op and has its own idempotent semantics, so splitting it is fine.
        await db.runTransaction(async (t) => {
            const userRef = db.collection('users').doc(uid);
            const userDoc = await t.get(userRef);
            const handle = userDoc.data()?.handle;

            t.update(userRef, {
                status: 'deactivated',
                deactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            if (handle) {
                t.delete(db.collection('handles').doc(handle));
            }
        });

        await adminAuth.revokeRefreshTokens(uid);

        // Message text was UI-facing — toast wording is now constructed
        // client-side. `data: null` for the standard envelope.
        return c.json({ success: true as const, data: null }, 200);
    } catch (err) {
        logger.error(
            { err, requestId: c.get('requestId'), uid },
            '[users-me] delete failed',
        );
        return c.json(errorEnvelope(c, 'Failed to deactivate account'), 500);
    }
});

export { app as usersMeRoute };
