import { Hono } from 'hono';
import { z } from 'zod';
import { requireSystemAuth } from '../../../middleware/system-auth.js';
import { getAdminAuth } from '../../../lib/firebase-admin.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { logger } from '../../../lib/logger.js';

/**
 * System-auth session-cookie minting endpoint mounted at
 * `/api/v1/system/auth/mint-session-cookie`.
 *
 *   POST /mint-session-cookie — exchange a Firebase ID token for a
 *                                session cookie value.
 *
 * **Requires system-auth, NOT user-auth.** The caller is apps/web's
 * `ensureSessionCookie` shim, which receives the ID token from the
 * browser (in the `Authorization` header) and forwards it here. End
 * users must never hit this endpoint — it would let an attacker
 * mint long-lived session cookies for any ID token they control.
 *
 * PR-F3b stage 4: moves the `firebase-admin`-backed
 * `adminAuth.createSessionCookie(...)` call out of apps/web. After this
 * stage `apps/web/src/lib/api/session-management.ts` no longer imports
 * `firebase-admin`. The `/auth/session` route itself stays on apps/web
 * because the cookie has to be set on apps/web's response (per-origin
 * cookie semantics — see specs/auth-architecture.md § Cross-Origin
 * Topology).
 *
 * ## Body shape
 *
 *   { idToken: string, expiresInMs: number }
 *
 * `expiresInMs` is bounded to match Firebase's allowed range
 * (5 min to 14 days). Tighter bounds can be applied by the caller —
 * apps/web uses 5 days, matching the previous default in
 * `SESSION_DURATION_SECONDS`.
 *
 * ## Response
 *
 *   200 { success: true, data: { sessionCookie: string } }
 *
 *   400 { success: false, error: { message, code: 'INVALID_ID_TOKEN' }, requestId }
 *        — Firebase rejected the ID token (expired, revoked, malformed,
 *        wrong project, etc.). The `code` discriminator lets the
 *        caller surface a 401 to the end user without re-parsing the
 *        message.
 */

const MintRequestSchema = z.object({
    /**
     * Firebase ID token to exchange. Validated by the underlying
     * `adminAuth.createSessionCookie` call (we don't pre-validate here
     * — Firebase's verifier owns the rules).
     */
    idToken: z.string().min(1),
    /**
     * Session cookie lifetime in milliseconds. Firebase enforces
     * 5 minutes ≤ expiresIn ≤ 14 days; we enforce the same bounds
     * here so a misconfigured caller gets a 400 instead of a 500.
     */
    expiresInMs: z
        .number()
        .int()
        .min(5 * 60 * 1000, 'expiresInMs must be at least 5 minutes')
        .max(14 * 24 * 60 * 60 * 1000, 'expiresInMs must be at most 14 days'),
});

const app = new Hono();

app.post('/mint-session-cookie', requireSystemAuth(), async (c) => {
    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = MintRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid request body', { issues: validation.error.issues }),
            400,
        );
    }

    const { idToken, expiresInMs } = validation.data;

    try {
        const sessionCookie = await getAdminAuth().createSessionCookie(idToken, {
            expiresIn: expiresInMs,
        });
        return c.json({ success: true, data: { sessionCookie } });
    } catch (err) {
        // Firebase rejects the ID token: expired, revoked, malformed,
        // from a different project, etc. Surface as 400 with a
        // discriminator code so apps/web can map to a 401 for the end
        // user without scraping the message. Anything else (Firebase
        // outage, network) falls through to the error handler as 500.
        const code = (err as { code?: string })?.code ?? '';
        const fbAuthError = code.startsWith('auth/');
        if (fbAuthError) {
            const message = err instanceof Error ? err.message : String(err);
            logger.info(
                { code, message },
                '[auth] createSessionCookie rejected ID token',
            );
            return c.json(
                errorEnvelope(c, 'Invalid ID token', { code: 'INVALID_ID_TOKEN' }),
                400,
            );
        }
        throw err;
    }
});

export { app as systemAuthMintRoute };
