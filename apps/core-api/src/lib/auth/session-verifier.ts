import { getAdminAuth, isUsingEmulator } from '../firebase-admin.js';
import { logger } from '../logger.js';

/**
 * Represents an authenticated session. Shape is compatible with Firebase's
 * `DecodedIdToken`: `uid` is always present, custom claims live as
 * additional properties. A non-Firebase SessionVerifier (generic OIDC,
 * self-hosted auth) can produce the same shape.
 */
export interface VerifiedSession {
    uid: string;
    [claim: string]: unknown;
}

/**
 * SessionVerifier is the portable auth-verification interface for core-api.
 * Core-api accepts **two** token flavors, unified behind `verifyToken`:
 *
 * 1. **Firebase ID tokens** — used by mobile, embed, and browser-side
 *    `authenticatedApi`. Obtained via `user.getIdToken()`. Short-lived
 *    (~1 hour).
 * 2. **Firebase session cookies** — used by apps/web RSC when its
 *    `server-proxy-http.ts` transport calls core-api. Minted by apps/web
 *    at login time. Long-lived.
 *
 * The Firebase Admin SDK has separate verify functions for each:
 * `verifyIdToken` and `verifySessionCookie`. They share JWT structure
 * but issue from different Firebase-controlled issuers — an ID token
 * fails session-cookie verification and vice versa.
 *
 * Rather than inspect JWT claims to route to the right verifier (which
 * would couple us to Firebase's internal claim shape), this impl
 * **tries both in sequence**. ID token first because that's the
 * hotter path (mobile + embed + browser); session cookie fallback for
 * RSC. Failure of the first is silent; failure of the second surfaces
 * as an invalid-session error.
 *
 * ## Swap-out
 *
 * For self-hosters wanting a non-Firebase identity provider, replace
 * `firebaseSessionVerifier` with an implementation that produces the
 * same `VerifiedSession` shape from whatever token format they use.
 */
export interface SessionVerifier {
    /**
     * Verify a bearer token (ID token OR session cookie). Throws on
     * invalid/expired/revoked tokens. Callers should catch and map to
     * a 401 response.
     */
    verifyToken(token: string): Promise<VerifiedSession>;
}

const firebaseSessionVerifier: SessionVerifier = {
    async verifyToken(token: string): Promise<VerifiedSession> {
        const checkRevoked = !isUsingEmulator();
        const auth = getAdminAuth();

        // Try ID token first (hotter path: mobile, embed, browser).
        try {
            const decoded = await auth.verifyIdToken(token, checkRevoked);
            return decoded as VerifiedSession;
        } catch (idTokenErr) {
            // Fall back to session cookie (RSC path).
            try {
                const decoded = await auth.verifySessionCookie(token, checkRevoked);
                return decoded as VerifiedSession;
            } catch (sessionCookieErr) {
                // Both failed — the token is neither a valid ID token nor
                // a valid session cookie. Log both for diagnostic triage.
                // `err` triggers pino's default error serializer (adds
                // type/message/stack). The other error is kept as a
                // secondary structured field with message + code so
                // nothing is lost in the log line.
                const altErr = idTokenErr as { message?: string; code?: string } | null;
                logger.warn(
                    {
                        err: sessionCookieErr,
                        idTokenErrMessage: altErr?.message,
                        idTokenErrCode: altErr?.code,
                    },
                    '[auth] token failed both ID-token and session-cookie verification',
                );
                throw sessionCookieErr;
            }
        }
    },
};

/**
 * Active SessionVerifier. Swappable for tests via module-level override.
 */
export const sessionVerifier: SessionVerifier = firebaseSessionVerifier;
