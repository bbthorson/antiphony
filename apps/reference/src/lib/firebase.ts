import { initializeApp } from 'firebase/app';
import {
    getAuth,
    connectAuthEmulator,
    signInAnonymously,
    getIdToken,
    type Auth,
} from 'firebase/auth';

/**
 * Firebase auth bootstrap for the reference app.
 *
 * The reference app only needs ONE thing from Firebase: a valid ID token to
 * present to core-api as `Authorization: Bearer <token>`. It does NOT touch
 * Firestore or Storage directly — all data access is mediated by core-api.
 *
 * Against the local emulator stack, an anonymous sign-in is enough: the auth
 * emulator mints a token, and core-api (also pointed at the same emulator)
 * verifies it. A `demo-` project id keeps the whole thing offline.
 */

const app = initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'demo-api-key',
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'demo-antiphony',
});

const auth: Auth = getAuth(app);

const emulatorHost = import.meta.env.VITE_AUTH_EMULATOR_HOST;
if (emulatorHost) {
    connectAuthEmulator(auth, `http://${emulatorHost}`, { disableWarnings: true });
}

let signInPromise: Promise<unknown> | null = null;

/** Sign in anonymously, deduped so concurrent callers share one request. */
async function ensureSignedIn(): Promise<void> {
    if (auth.currentUser) return;
    signInPromise ??= signInAnonymously(auth);
    await signInPromise;
}

/** Returns a fresh Firebase ID token, signing in first if needed. */
export async function getAuthToken(): Promise<string> {
    await ensureSignedIn();
    if (!auth.currentUser) throw new Error('Sign-in failed: no current user');
    return getIdToken(auth.currentUser);
}

/** The signed-in user's uid (after `getAuthToken`), or null. */
export function currentUid(): string | null {
    return auth.currentUser?.uid ?? null;
}
