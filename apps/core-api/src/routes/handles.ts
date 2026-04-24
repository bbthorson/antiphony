import { Hono } from 'hono';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import { firebaseUserDependencies } from '../services/users-dependencies.js';
import { userService } from '../services/core-services-firebase.js';

/**
 * GET /api/v1/handles
 *
 * Returns every public handle (doc IDs of the `handles` collection).
 * Used by the sitemap generator to enumerate user profile URLs. Public —
 * no auth required; rate-limited by IP per `RATE_LIMITS.read`.
 *
 * Response shape (matches apps/web's parity endpoint):
 *   { success: true, data: string[] }
 *
 * Parity with: apps/web/src/app/api/v1/handles/route.ts
 *
 * GET /api/v1/handles/check?handle=xyz
 *
 * Availability check for a handle during signup / profile edit. Requires an
 * authenticated viewer so the endpoint can flag "taken by you" (`owned: true`)
 * distinctly from "taken by someone else" (`available: false`). Matches
 * apps/web's parity endpoint semantics.
 *
 * Response shape:
 *   - `{ available: true }` — handle is free
 *   - `{ available: true, owned: true }` — handle is owned by the viewer
 *   - `{ available: false, reason: 'invalid' | 'taken' }` — not usable
 *
 * Uses the existing `resolveHandle` binding method directly rather than
 * adding a dedicated `UserService` method. The underlying operation is a
 * single handle-doc read, and this mirrors apps/web's route which also
 * bypasses the service layer for this check.
 *
 * Parity with: apps/web/src/app/api/v1/handles/check/route.ts
 */

const app = new Hono();

app.get('/', rateLimit(RATE_LIMITS.read), async (c) => {
    const handles = await userService.getAllPublicHandles();
    return c.json({
        success: true,
        data: handles,
    });
});

app.get('/check', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const viewerUid = c.get('viewerUid');
    const raw = c.req.query('handle');
    const handle = raw?.toLowerCase();
    if (!handle || handle.length < 3 || !/^[a-z0-9_]+$/.test(handle)) {
        return c.json({ available: false, reason: 'invalid' });
    }

    const ownerUid = await firebaseUserDependencies.resolveHandle(handle);
    if (!ownerUid) {
        return c.json({ available: true });
    }
    if (ownerUid === viewerUid) {
        return c.json({ available: true, owned: true });
    }
    return c.json({ available: false, reason: 'taken' });
});

export { app as handlesRoute };
