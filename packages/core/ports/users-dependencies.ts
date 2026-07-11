/**
 * UserDependencies is the portable interface that UserService (and the
 * `/system/*` identity routes) use to access the user-identity store. Lives in
 * `packages/core/` alongside the class; the Firestore + Firebase Auth binding
 * lives in `apps/core-api/src/adapters/outbound/firebase/`.
 *
 * Scope is the identity primitives only — DID→uid resolution, stub creation,
 * handle claim, and Bluesky-identity linking. The public-profile projection
 * (ProfileView reads) was retired with the author-shape change (see
 * specs/core-surface.md).
 *
 * The handle-swap transaction is collapsed into the high-level
 * `updateUserProfile` method rather than exposing a generic `runTransaction`.
 */

/**
 * The narrow write surface the atproto-signin onboarding flow needs: a handle
 * claim plus a display-name snapshot. The core holds no other profile data —
 * bio/avatar/links and the rest of the profile surface are BFF-owned (see
 * specs/core-surface.md).
 */
export interface UpdateProfileDto {
    handle?: string;
    displayName?: string | null;
    updatedAt?: Date;
    id?: string;
    createdAt?: Date;
}

export interface UserDependencies {
    // --- Reads ---

    /** Find a uid by linked AT Protocol DID (`bluesky.did` field). Returns null if no match. */
    findUserByDid(did: string): Promise<string | null>;

    // --- Writes ---

    /**
     * Create a stub user document if it doesn't already exist.
     * Returns true if the stub was created; false if a user already existed.
     */
    ensureUserStub(uid: string): Promise<boolean>;

    /**
     * Atomically update a user profile. If `updates.handle` is set and
     * different from the current handle, performs a handle swap:
     *   - claims `handles/{newHandle}` for the user (throws ConflictError
     *     if already owned by a different uid)
     *   - releases `handles/{oldHandle}` if one existed
     *   - applies the profile updates with merge
     *
     * This is the one operation where atomicity is a correctness requirement:
     * a partially-applied handle swap produces duplicate handle claims.
     */
    updateUserProfile(uid: string, updates: UpdateProfileDto): Promise<void>;

    /**
     * Write the AT Protocol identity to a user's profile post-OAuth-
     * callback. `handle` is the user-supplied Bluesky handle (validated
     * by the PDS during auth); `did` is the durable identifier the
     * PDS returns. Last-write-wins: relinking from a different handle
     * overwrites the previous binding.
     */
    setBlueskyIdentity(uid: string, identity: { handle: string; did: string }): Promise<void>;

    now(): Date;
}
