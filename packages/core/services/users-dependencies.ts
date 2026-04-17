import type { UserRecord, ProfileView } from 'shared/types';

/**
 * UserDependencies is the portable interface that UserService uses to access
 * the underlying data store and identity provider. Lives in `packages/core/`
 * alongside the class; the Firestore + Firebase Auth binding lives in
 * `apps/web/src/services/users-dependencies.ts`.
 *
 * Design notes:
 *  - Firebase Auth access is a single narrow method (`getPhoneNumbersForUids`).
 *  - The handle-swap transaction is collapsed into the high-level
 *    `updateUserProfile` method rather than exposing a generic `runTransaction`.
 */

export interface UpdateProfileDto {
    handle?: string;
    bio?: string;
    avatarUrl?: string | null;
    updatedAt?: Date;
    id?: string;
    createdAt?: Date;
}

export interface UserDependencies {
    // --- Reads ---

    /** Resolve a handle to a uid via the `handles` collection (source of truth). */
    resolveHandle(handle: string): Promise<string | null>;

    /** Legacy fallback: find a user by the `handle` field on the `users` collection. Skips deactivated. */
    findProfileByHandleField(handle: string): Promise<ProfileView | null>;

    /** Legacy fallback: find a user by the `username` field on the `users` collection. Skips deactivated. */
    findProfileByUsernameField(username: string): Promise<ProfileView | null>;

    /** Fetch a ProfileView by UID, merging in RSS enrichment. Skips deactivated. */
    getProfileByUid(uid: string): Promise<ProfileView | null>;

    /**
     * Batch fetch ProfileViews by UIDs. Deduplicates inputs. Does NOT skip
     * deactivated accounts — callers that need that filter should apply it
     * themselves (matches existing behavior).
     */
    getProfilesByIds(uids: string[]): Promise<ProfileView[]>;

    /** Fetch a schema-validated UserRecord by UID. */
    getUserRecordByUid(uid: string): Promise<UserRecord | null>;

    /** Return every handle string (doc IDs of the `handles` collection). */
    listAllHandles(): Promise<string[]>;

    // --- Identity provider ---

    /**
     * Look up phone numbers for a set of uids via the identity provider.
     * Missing phones (or auth lookup failures) produce absent keys rather
     * than throwing — callers treat phone data as best-effort enrichment.
     */
    getPhoneNumbersForUids(uids: string[]): Promise<Map<string, string>>;

    // --- Writes ---

    /**
     * Create a stub user document if it doesn't already exist.
     * Returns true if the stub was created; false if a user already existed.
     * Callers use the return value to decide whether to run first-time
     * side-effects (e.g., creating the General Inbox prompt).
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

    now(): Date;
}
