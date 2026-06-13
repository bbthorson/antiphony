import type { UserRecord } from 'shared/types/records';
import type { ProfileView } from 'shared/types/views';
import { NotFoundError } from 'shared/errors';
import type { CoreServices } from '../ports/core-services';
import type { UpdateProfileDto, UserDependencies } from '../ports/users-dependencies';
import { type Logger, defaultLogger } from '../ports/logger';

export type { UpdateProfileDto } from '../ports/users-dependencies';

const DEFAULT_SYSTEM_GREETING_URL = 'https://storage.googleapis.com/voxpop-public/defaults/inbox-greeting.mp3';

/**
 * UserService is the business-logic layer for users: handle resolution,
 * profile hydration, onboarding, and handle-swap orchestration. Data access
 * is delegated to an injected `UserDependencies` binding; peer-service
 * access (e.g., creating the General Inbox prompt in `ensureUserExists`)
 * flows through the injected `CoreServices` (Phase 2.5 DI container).
 *
 * Lives in `packages/core/` as of Task E.4. The Firebase-backed binding
 * (Firestore + Firebase Auth) and singleton construction live in
 * `apps/web/src/services/users.ts` as the composition layer.
 */
export class UserService {
    constructor(
        private readonly deps: UserDependencies,
        private readonly services: CoreServices,
        private readonly logger: Logger = defaultLogger,
    ) {}

    async getUserData(handle: string): Promise<ProfileView | null> {
        // Trim but keep original case for the UID fallback — Firebase Auth
        // UIDs are case-sensitive, so lowercasing `sLhaGagvW5NE...` to
        // `slhagagvw5ne...` would cause the UID lookup to 404.
        const trimmedInput = handle ? handle.trim() : '';
        if (!trimmedInput) return null;
        const sanitizedHandle = trimmedInput.toLowerCase();
        this.logger.info({ handle: sanitizedHandle }, '[UserService] Fetching user data for handle');

        try {
            // 1. Check `handles` collection first (source of truth).
            const uid = await this.deps.resolveHandle(sanitizedHandle);
            if (uid) {
                this.logger.info({ handle: sanitizedHandle, uid }, '[UserService] Resolved handle to UID');
                return this.getUserDataByUid(uid);
            }

            // 2. Legacy fallback: query `users` collection by handle/username field.
            this.logger.info({ handle: sanitizedHandle }, '[UserService] Handle not found in handles collection, trying legacy query');
            const byHandle = await this.deps.findProfileByHandleField(sanitizedHandle);
            if (byHandle) return byHandle;

            this.logger.info({ handle: sanitizedHandle }, '[UserService] No user found with handle, trying username fallback');
            const byUsername = await this.deps.findProfileByUsernameField(sanitizedHandle);
            if (byUsername) return byUsername;

            // 3. Final fallback: direct UID lookup (handles URLs built with
            // userId). Pass the case-preserving `trimmedInput`, not the
            // lowercased `sanitizedHandle` — UIDs are case-sensitive.
            this.logger.info({ handle: sanitizedHandle }, '[UserService] No user found with handle/username, trying UID lookup');
            return await this.getUserDataByUid(trimmedInput);
        } catch (error) {
            this.logger.error({ handle, err: error }, '[UserService] Error fetching user data');
            throw error;
        }
    }

    async getUserDataByUid(uid: string): Promise<ProfileView | null> {
        this.logger.info({ uid }, '[UserService] Fetching user data for UID');
        try {
            return await this.deps.getProfileByUid(uid);
        } catch (error) {
            this.logger.error({ uid, err: error }, '[UserService] Error fetching user data for UID');
            throw error;
        }
    }

    async getUsersByIds(uids: string[], options: { includePrivateData?: boolean } = {}): Promise<ProfileView[]> {
        if (!uids.length) return [];

        const profiles = await this.deps.getProfilesByIds(uids);

        // Phone-number enrichment: only for lite users (no handle) when
        // private data is requested. Best-effort — failures degrade silently.
        if (options.includePrivateData) {
            const liteUserIds = profiles.filter(p => !p.handle).map(p => p.id);
            if (liteUserIds.length > 0) {
                const phoneMap = await this.deps.getPhoneNumbersForUids(liteUserIds);
                for (const profile of profiles) {
                    const phone = phoneMap.get(profile.id);
                    if (phone) profile.phoneNumber = phone;
                }
            }
        }

        return profiles;
    }

    async findUidByDid(did: string): Promise<string | null> {
        return this.deps.findUserByDid(did);
    }

    async getUserRecordByUid(uid: string): Promise<UserRecord | null> {
        try {
            return await this.deps.getUserRecordByUid(uid);
        } catch (error) {
            this.logger.error({ uid, err: error }, '[UserService] Error fetching user record for UID');
            throw error;
        }
    }

    /**
     * Ensures a user document exists — creates a stub if missing, then
     * creates the General Inbox prompt (also only if missing).
     *
     * Order matters: user is written BEFORE the prompt, because prompt
     * creation references the user as author.
     */
    async ensureUserExists(uid: string): Promise<void> {
        let created: boolean;
        try {
            created = await this.deps.ensureUserStub(uid);
        } catch (error) {
            this.logger.error({ err: error }, '[UserService] Error creating stub user');
            throw new NotFoundError('Failed to create user profile');
        }

        if (!created) return;
        this.logger.info({ uid }, '[UserService] Created stub user');

        try {
            const inboxId = `inbox_${uid}`;
            const inboxPrompt = await this.services.prompts.getPromptRecord(inboxId);
            if (!inboxPrompt) {
                await this.services.prompts.createPrompt({
                    id: inboxId,
                    title: 'General Inbox',
                    description: 'System prompt for SIP voicemails',
                    status: 'archived',
                    audioUrl: DEFAULT_SYSTEM_GREETING_URL,
                    authorId: uid,
                    createdAt: this.deps.now(),
                });
                this.logger.info({ uid }, '[UserService] Created General Inbox');
            }
        } catch (error) {
            this.logger.error({ err: error }, '[UserService] Error creating General Inbox prompt');
            throw new NotFoundError('Failed to create user profile');
        }
    }

    /**
     * Atomically updates a user profile. Handle changes trigger a handle-swap
     * transaction inside the deps layer (claim + release + ConflictError
     * on collision).
     */
    async updateUserProfile(uid: string, updates: UpdateProfileDto): Promise<void> {
        const normalized: UpdateProfileDto = { ...updates };
        if (normalized.handle) {
            normalized.handle = normalized.handle.toLowerCase();
        }
        await this.deps.updateUserProfile(uid, normalized);
    }

    async getAllPublicHandles(): Promise<string[]> {
        return this.deps.listAllHandles();
    }

    /**
     * Remove the linked AT Protocol identity from a user's profile.
     * Thin wrapper around the dep call — kept on the service for parity
     * with other write methods and so callers can stay on the service
     * surface rather than reaching into deps directly.
     */
    async disconnectAtproto(uid: string): Promise<void> {
        await this.deps.removeBlueskyIdentity(uid);
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
