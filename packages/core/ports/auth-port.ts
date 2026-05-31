import { z } from 'zod';

/**
 * AuthPort — the canonical contract for client-side authentication.
 *
 * Step 1 of `specs/drafts/auth-hardening.md`. This file defines the
 * shape; no consumers yet. Steps 2+ implement adapters
 * (`FirebaseAuthAdapter`, `StubAuthAdapter`, future `DidAuthAdapter`)
 * and migrate callers off the current ad-hoc `useAuth()` shape +
 * silent `Promise<string | null>` token API.
 *
 * ## Why this file exists
 *
 * Bugs 1/2/3 from `specs/drafts/post-roadmap-followups.md` all traced
 * back to the same auth design seams:
 *   - Silent `null` from `getToken()` overloaded across 4 distinct
 *     meanings (not signed in / hydrating / refresh failed / lost mid-call)
 *   - Aggressive `forceRefresh: true` on every protected call
 *   - Three racing "is auth ready?" signals (`loading`, `user`,
 *     `authService.currentUser`)
 *   - Per-route-group `AuthenticatedProviders` mounts → cross-layout
 *     remount races
 *   - Five fragmented user-facing error strings for 3 underlying causes
 *
 * The port collapses the auth state into one Zod-validated discriminated
 * union, makes token retrieval return `Result<T, AuthError>` (TypeScript
 * exhaustiveness enforces both-branches handling at every call site),
 * and absorbs reCAPTCHA as auth infrastructure rather than treating it
 * as a public-page UX concern.
 *
 * ## Concrete bindings (future)
 *
 * Implementations live in `apps/web/src/lib/auth/`:
 *   - `firebase-adapter.ts` (Step 2)
 *   - `stub-adapter.ts` (Step 3 — anonymous routes, no Firebase import)
 *   - `did-adapter.ts` (Step 8 — AT Proto OAuth)
 *
 * Each implements `AuthPort`. Layouts inject the right adapter via a
 * thin `<AuthAdapterScope>` wrapper into a single root-mounted provider
 * (Step 6) — preserves the ~200kB SDK-chunk savings from PR #397
 * without the per-layout remount race.
 *
 * ## Embed portability
 *
 * `packages/embed-ui/src/ports.ts` defines its own narrower `AuthProvider`
 * interface used by `ReplyDot`. That interface is a STRICT SUBSET of the
 * canonical `AuthPort` defined here — only the fields ReplyDot actually
 * touches. When apps/web migrates to this port, the embed-ui port stays
 * compatible (apps/web's adapter satisfies both shapes). The standalone
 * `apps/embed/` Vite app continues to pass `null` for auth on the embed
 * port — it never auths in-frame.
 */

// =============================================================================
// Result<T, E> — discriminated union for type-safe error handling
// =============================================================================

/**
 * Two-variant discriminated union. Forces exhaustive handling at the
 * call site via TypeScript's narrowing on the `ok` field.
 *
 * Why not throws? Throws are invisible to the type system — a caller
 * can forget `try`/`catch` and the compiler is silent about it. With
 * `Result`, the caller MUST branch on `result.ok` to reach the value
 * or error. The class of "I forgot to handle the failure" bugs that
 * surfaced in Bug 2 (where `submitReply` awaited `getToken(true)` and
 * the thrown refresh failure escaped the function unannounced) is
 * structurally impossible against this contract.
 */
export type Result<T, E> =
    | { ok: true; value: T }
    | { ok: false; error: E };

/** Helper: construct an Ok result. */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Helper: construct an Err result. */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// =============================================================================
// AuthError — the ways auth can fail at the port boundary
// =============================================================================

/**
 * Discriminated by `code` so exhaustive switches in the user-facing
 * error catalog catch missing cases at compile time.
 *
 * Adding a new variant requires updating the message catalog (Step 5
 * of the migration plan) — that's a feature, not a bug.
 *
 * Variants split by lifecycle phase:
 *   - **Pre-flight / state errors**: `not-signed-in`, `hydrating`,
 *     `refresh-failed`, `session-lost`.
 *   - **Sign-in errors**: `invalid-credential` (wrong OTP, invalid
 *     phone), `rate-limited` (Firebase too-many-attempts), and the
 *     catch-all `internal-error` (everything else the adapter can't
 *     classify into a known code).
 *   - **Configuration errors**: `verification-misconfigured` (bad
 *     reCAPTCHA site key, domain not allowlisted, etc.).
 *
 * Adapters round-trip their errors through this schema (Step 2 of the
 * migration), so any error path an adapter can produce MUST map to
 * one of these codes — otherwise the validation throws at the adapter
 * boundary and we lose the original error.
 */
export const AuthErrorSchema = z.discriminatedUnion('code', [
    z.object({
        code: z.literal('not-signed-in'),
    }),
    z.object({
        code: z.literal('hydrating'),
    }),
    z.object({
        code: z.literal('refresh-failed'),
        /** Underlying error message — for logs, not user-facing. */
        cause: z.string(),
    }),
    z.object({
        code: z.literal('session-lost'),
    }),
    z.object({
        code: z.literal('verification-misconfigured'),
        /** Underlying error message — for logs + diagnostic display. */
        cause: z.string(),
    }),
    z.object({
        code: z.literal('invalid-credential'),
        /**
         * Which credential the adapter rejected — `'phone'` for an
         * invalid phone number format, `'code'` for a wrong OTP,
         * `'token'` for a malformed/expired auth token, `'email'` for a
         * bad/expired magic-link (or an email-mismatch on completion).
         * The message catalog uses this to pick the right user-facing
         * copy.
         */
        which: z.enum(['phone', 'code', 'token', 'email']),
    }),
    z.object({
        code: z.literal('rate-limited'),
        /**
         * Optional retry hint — seconds until the user can try again.
         * Omitted when the adapter can't surface a precise window
         * (Firebase Auth usually doesn't return one).
         */
        retryAfterSeconds: z.number().optional(),
    }),
    z.object({
        /**
         * Catch-all for adapter errors that don't fit a more specific
         * code. Carries the underlying message for logs and diagnostic
         * display, but should be USED SPARINGLY — every recurring
         * shape should get its own code so the message catalog can
         * give the user actionable copy.
         */
        code: z.literal('internal-error'),
        cause: z.string(),
    }),
]);

export type AuthError = z.infer<typeof AuthErrorSchema>;

// =============================================================================
// AuthState — the auth subsystem's state machine
// =============================================================================

/**
 * Discriminated by `status` — exhaustively matches via TypeScript
 * narrowing. Collapses the three racing readiness signals
 * (`loading: boolean`, `user: User | null`, `authService.currentUser`)
 * into one canonical shape.
 *
 * Adapter-specific user fields can be added later as new variants or
 * via discriminated extension — keep this surface minimal until a
 * real need emerges. Resist the temptation to mirror `firebase.User`
 * here; only the fields ReplyDot / AuthGate / SettingsForm actually
 * read should land in the canonical user shape.
 */
export const AuthStateSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('hydrating'),
        // No user yet — adapter is restoring from persistent storage
        // (Firebase IndexedDB, an AT Proto session blob, etc.) or
        // waiting on its first state callback.
    }),
    z.object({
        status: z.literal('signed-in'),
        user: z.object({
            uid: z.string(),
            phoneNumber: z.string().nullable(),
            // Add fields here ONLY when a consumer explicitly needs
            // them — adding speculatively grows the surface and forces
            // every adapter to populate fields it might not have.
        }),
    }),
    z.object({
        status: z.literal('signed-out'),
        // No user. Distinct from `hydrating` so consumers can render
        // sign-in UI without flicker — once the adapter knows the user
        // isn't signed in, it commits to that state immediately.
    }),
    z.object({
        status: z.literal('refresh-failed'),
        /**
         * The uid we had before refresh failed — kept for analytics /
         * diagnostic display only. Recovery requires fresh sign-in;
         * callers should treat this as effectively signed-out for UI
         * purposes (e.g. show "Sign in again" copy).
         *
         * Nullable because some failure paths can't recover the
         * pre-failure uid — corrupted local storage, a cleared session
         * in another tab, an adapter that observes the refresh failure
         * before it has access to the previous identity. Emitters that
         * DO know the uid should populate it; emitters that don't
         * MUST emit `null` rather than omitting the field (Zod would
         * reject an omission).
         */
        lastKnownUid: z.string().nullable(),
        /** Underlying error message — for logs, not user-facing. */
        error: z.string(),
    }),
]);

export type AuthState = z.infer<typeof AuthStateSchema>;

// =============================================================================
// RecaptchaVerifierLike — SDK-agnostic shim for reCAPTCHA
// =============================================================================

/**
 * Minimal shape that adapters present to consumers. Today Firebase's
 * `RecaptchaVerifier` satisfies this surface; a future identity backend
 * that needs CAPTCHA could provide an equivalent wrapper without leaking
 * Firebase types through the port.
 *
 * Test fakes can implement this directly without pulling in the heavy
 * Firebase SDK.
 */
export interface RecaptchaVerifierLike {
    /**
     * Run the verifier and return a token suitable for the adapter's
     * sign-in flow. For Firebase phone auth this is the reCAPTCHA
     * response token; the adapter consumes it inside `signInWithPhone`.
     */
    verify(): Promise<string>;
    /** Tear down the verifier. Safe to call multiple times. */
    clear(): void;
}

// =============================================================================
// AuthPort — the canonical interface adapters implement
// =============================================================================

/**
 * Options for the sign-in surface. Today only Firebase phone is
 * supported; future variants discriminate via the `method` field so
 * adapters can refuse methods they don't implement at the type level.
 *
 * The `method`-discriminated shape was chosen over per-adapter `signIn`
 * methods because it keeps the port singular (one `signIn`, one
 * `confirmSignIn`) at the cost of forcing each adapter to handle
 * unsupported methods explicitly — usually by returning
 * `err({ code: 'not-implemented-by-adapter' })` (a code that may need
 * adding to `AuthError` in Step 8 when DID-OAuth lands).
 */
export type SignInOptions =
    | {
          method: 'firebase-phone';
          phoneNumber: string;
          verifier: RecaptchaVerifierLike;
      }
    | {
          // Email magic link — two-phase. `signIn` *sends* the link;
          // `confirmSignIn` completes it on the landing page (the link's
          // URL carries the one-time code, so there's no confirmation id).
          method: 'firebase-email-link';
          email: string;
      }
    // Future: { method: 'did-oauth'; handle: string; redirectUri: string }
    ;

/**
 * Result of `signIn` — for phone auth this is the confirmation handle
 * that `confirmSignIn` consumes. For magic link there's no handle (the
 * emailed URL carries it); the caller just tells the user to check their
 * inbox. For future DID flows this could be a redirect URL.
 */
export type SignInResult =
    | { method: 'firebase-phone'; confirmationId: string }
    | { method: 'firebase-email-link' }
    // Future: { method: 'did-oauth'; redirectUrl: string }
    ;

/**
 * Options for `confirmSignIn`. Discriminated to match `SignInResult`.
 */
export type ConfirmSignInOptions =
    | { method: 'firebase-phone'; confirmationId: string; code: string }
    | {
          // Complete a magic-link sign-in from the landing page. `url` is
          // the full current location (it embeds the one-time link code);
          // `email` is the address the link was sent to.
          method: 'firebase-email-link';
          email: string;
          url: string;
      }
    // Future: { method: 'did-oauth'; ... }
    ;

/**
 * Options for `linkPhone` — sends an OTP to a phone number to bind it to
 * the *currently signed-in* account. Distinct from `signIn({ method:
 * 'firebase-phone' })`, which authenticates a (possibly new) user.
 */
export interface LinkPhoneOptions {
    phoneNumber: string;
    verifier: RecaptchaVerifierLike;
}

/** Options for `confirmLinkPhone` — the OTP plus the handle from `linkPhone`. */
export interface ConfirmLinkPhoneOptions {
    confirmationId: string;
    code: string;
}

/**
 * The canonical auth port. All implementations satisfy this contract;
 * consumers depend on it (not on concrete adapters).
 *
 * Lifecycle methods return `Result<T, AuthError>` so failure is part
 * of the type signature. Reactive state is observable via
 * `subscribe` + synchronously readable via `getState`.
 */
export interface AuthPort {
    // -------------------------------------------------------------------------
    // Reactive state
    // -------------------------------------------------------------------------

    /**
     * Subscribe to state changes. Returns an unsubscribe function.
     * The callback fires with the current state immediately on
     * subscription, then again on every state transition.
     */
    subscribe(callback: (state: AuthState) => void): () => void;

    /**
     * Synchronously read the current state. Useful inside event
     * handlers where awaiting `whenReady` is overkill — the caller
     * is OK with `hydrating` as a possible answer.
     */
    getState(): AuthState;

    /**
     * Settles once when the auth subsystem has determined its initial
     * answer (not `hydrating`). Replaces the racing `loading: boolean`
     * + `user: User | null` + `authService.currentUser` signals with
     * one canonical promise.
     *
     * Subsequent state changes (sign-out, refresh-failed, mid-session
     * sign-in) are observed via `subscribe`. This promise does NOT
     * resolve again on later transitions — it captures the initial-load
     * answer only.
     *
     * Returns `Result<AuthState, AuthError>` rather than throwing on
     * timeout. The port avoids throws everywhere else (every other
     * lifecycle method returns `Result`); making `whenReady` the lone
     * exception would force callers to mix `try`/`catch` with
     * `Result.ok` checks. On timeout, returns
     * `err({ code: 'hydrating' })` so the caller can show a
     * "still loading…" UI rather than hanging indefinitely.
     *
     * @param timeoutMs Defaults to 10000.
     */
    whenReady(timeoutMs?: number): Promise<Result<AuthState, AuthError>>;

    // -------------------------------------------------------------------------
    // Token retrieval — Result-typed, never returns null silently
    // -------------------------------------------------------------------------

    /**
     * Fetch a token for the currently signed-in user.
     *
     * `forceRefresh` is OPT-IN, not default. The current Firebase
     * adapter passes `forceRefresh: true` on every protected call —
     * pays a 200ms–3s round-trip even when the cached token is valid.
     * The 401-retry path in the API client is the only legitimate
     * force-refresh case (Step 4 of the migration plan drops the
     * other call site).
     *
     * Returns:
     *   - `ok(token)` on success
     *   - `err({ code: 'not-signed-in' })` if no user
     *   - `err({ code: 'hydrating' })` if the adapter hasn't settled
     *   - `err({ code: 'refresh-failed', cause })` if refresh threw
     *   - `err({ code: 'session-lost' })` if the user signed out
     *     mid-call (rare race during cross-tab logout)
     */
    getToken(opts?: { forceRefresh?: boolean }): Promise<Result<string, AuthError>>;

    // -------------------------------------------------------------------------
    // Phone OTP / reCAPTCHA — auth infrastructure, lives on the port
    // -------------------------------------------------------------------------

    /**
     * Acquire a reCAPTCHA verifier ready for use in `signIn`. Idempotent:
     * repeated calls return the same verifier (or a freshly-rendered one
     * if a prior verifier was cleared).
     *
     * Adapters that don't need CAPTCHA (a future DID OAuth flow) can
     * return `err({ code: 'verification-misconfigured', cause: '...' })`
     * — but typically those adapters won't be paired with `signIn`
     * options that need the verifier in the first place.
     */
    getRecaptchaVerifier(): Promise<Result<RecaptchaVerifierLike, AuthError>>;

    // -------------------------------------------------------------------------
    // Lifecycle — sign-in / confirm / sign-out
    // -------------------------------------------------------------------------

    /**
     * Begin a sign-in. For Firebase phone auth, this sends the OTP and
     * returns a confirmation handle. For magic link, it sends the email
     * and returns `{ method: 'firebase-email-link' }` (no handle — the
     * link carries the code). The caller then either prompts for the OTP
     * and calls `confirmSignIn` (phone) or tells the user to check their
     * inbox (email link).
     */
    signIn(opts: SignInOptions): Promise<Result<SignInResult, AuthError>>;

    /**
     * Complete a sign-in started via `signIn`. On success, the adapter
     * transitions state to `signed-in` and emits via `subscribe`.
     */
    confirmSignIn(opts: ConfirmSignInOptions): Promise<Result<void, AuthError>>;

    /**
     * Whether `url` is a Firebase email-sign-in (magic) link. Pure check
     * with no side effects — callers use it to gate magic-link completion
     * (and avoid premature redirects) on the landing page. Synchronous
     * because adapters answer it from the URL shape alone.
     *
     * Adapters without an email-link concept (stub, future DID) return
     * `false`.
     */
    isEmailSignInLink(url: string): boolean;

    /**
     * Sign out. Transitions state to `signed-out`. Adapter-specific
     * cleanup (clearing Firebase IndexedDB, the server-side session
     * cookie, etc.) is the adapter's responsibility.
     */
    signOut(): Promise<Result<void, AuthError>>;

    // -------------------------------------------------------------------------
    // Credential linking — bind an additional credential to the CURRENT user
    // (state-preserving; the user stays signed in)
    // -------------------------------------------------------------------------

    /**
     * Send an OTP to bind `phoneNumber` to the currently signed-in
     * account (e.g. a creator adding a phone in Settings). Distinct from
     * `signIn({ method: 'firebase-phone' })`, which authenticates a user —
     * this links and leaves the existing session intact. Returns a
     * confirmation handle for `confirmLinkPhone`. `err({ code:
     * 'not-signed-in' })` if there's no current user to link to.
     */
    linkPhone(opts: LinkPhoneOptions): Promise<Result<{ confirmationId: string }, AuthError>>;

    /**
     * Complete a `linkPhone` by confirming the OTP. On success the phone
     * credential is bound to the current user (no state transition — the
     * same user stays signed in, now with a phone number).
     */
    confirmLinkPhone(opts: ConfirmLinkPhoneOptions): Promise<Result<void, AuthError>>;
}
