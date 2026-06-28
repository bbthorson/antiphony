import type { ProfileView } from 'shared/types/views';

/**
 * CoreServices is the service-to-service dependency-injection seam for the
 * core tier. Core-tier code calls peer services through a narrow contract
 * interface rather than importing concrete singletons, keeping the Firebase
 * transitive-dep graph out of `packages/core/`.
 *
 * After the legacy content/org model was removed, the only surviving
 * cross-service dependency is **user identity**: the `audio-posts` outbound
 * binding hydrates post authors via `users.getUsersByIds`. The interface is
 * deliberately narrow — expand it when a new caller needs a new method; do
 * not mirror entire service surfaces speculatively.
 *
 * ## Concrete binding
 *
 * The Firebase-backed `CoreServices` implementation lives in
 * `apps/core-api/src/adapters/outbound/firebase/core-services-firebase.ts`.
 * Tests can construct their own `CoreServices` objects with mock
 * implementations; no mocking of `firebase-admin` is required.
 */

export interface UserServiceContract {
    getUserData(handle: string): Promise<ProfileView | null>;
    getUserDataByUid(uid: string): Promise<ProfileView | null>;
    /**
     * Batch variant — used by audio-post hydration to load post authors.
     * When `includePrivateData` is set, the binding may also enrich lite
     * users (no handle) with phone numbers from the identity provider.
     */
    getUsersByIds(uids: string[], options?: { includePrivateData?: boolean }): Promise<ProfileView[]>;

    /** Idempotent identity-stub creation. */
    ensureUserExists(uid: string): Promise<void>;
}

/**
 * The dependency surface that core-tier services depend on for cross-service
 * calls. Passed into core service constructors / bindings.
 *
 * Naming: keyed by domain (`users`) rather than class name, so callers read
 * like `services.users.getUserData(...)`.
 */
export interface CoreServices {
    users: UserServiceContract;
}
