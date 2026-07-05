import { NotFoundError } from 'shared/errors';
import type { UserDependencies } from '../ports/users-dependencies';
import { type Logger, defaultLogger } from '../ports/logger';

/**
 * UserService is the business-logic layer for the user-identity primitives
 * Antiphony still owns: DID→uid resolution, identity-stub creation, and
 * Bluesky-identity linking. These back the `/system/*` identity routes.
 *
 * Antiphony holds no user *profile* data — the public-profile projection
 * (handle resolution, ProfileView hydration) was retired when post-view
 * authors shrank to opaque `authorId`/`authorDid` refs (see
 * specs/core-surface.md, "The author model"). Profile identity lives in the
 * caller BFF.
 *
 * Data access is delegated to an injected `UserDependencies` binding; the
 * Firebase-backed binding lives in
 * `apps/core-api/src/adapters/outbound/firebase/` as the composition layer.
 */
export class UserService {
    constructor(
        private readonly deps: UserDependencies,
        private readonly logger: Logger = defaultLogger,
    ) {}

    async findUidByDid(did: string): Promise<string | null> {
        return this.deps.findUserByDid(did);
    }

    /**
     * Ensures a user document exists — creates an identity stub if missing.
     * Idempotent: a no-op when the user doc is already present.
     */
    async ensureUserExists(uid: string): Promise<void> {
        try {
            await this.deps.ensureUserStub(uid);
        } catch (error) {
            this.logger.error({ err: error }, '[UserService] Error creating stub user');
            throw new NotFoundError('Failed to create user profile');
        }
    }

    /**
     * Write the AT Protocol identity to a user's profile after a
     * successful OAuth callback. Called by the system-auth endpoint
     * that apps/web's `/api/v1/atproto/callback` route hits post-flow.
     */
    async setBlueskyIdentity(uid: string, identity: { handle: string; did: string }): Promise<void> {
        await this.deps.setBlueskyIdentity(uid, identity);
    }
}
