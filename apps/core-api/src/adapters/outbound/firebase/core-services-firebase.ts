import { UserService } from '@antiphony/core/services/users';
import { AudioPostService } from '@antiphony/core/services/audio-posts';
import { makeStorageService } from '@antiphony/core/services/storage';
import type { CoreServices } from '@antiphony/core/ports/core-services';
import { firebaseUserDependencies } from './users-dependencies.js';
import { firebaseAudioPostDependencies } from './audio-posts-dependencies.js';
import { firebaseBlobStore } from './storage-dependencies.js';
import { logger } from '../../../lib/logger.js';

/**
 * Firebase-wired `CoreServices` binding for core-api.
 *
 * After the legacy content/org model was removed, the canonical surface is
 * actor identity (`UserService`) plus the Antiphony audio-post model
 * (`AudioPostService`). The only cross-service dependency that survives is
 * user-identity hydration, exposed via `firebaseCoreServices.users` and
 * consumed by the audio-post outbound binding to load post authors.
 *
 * Note: no React `cache()` wrappers (unlike apps/web's binding). Core-api
 * isn't an RSC runtime.
 */

// The CoreServices aggregate delegates to `userService` (defined below) via
// arrow functions, which evaluate the identifier at call time — so there's no
// module-load ordering hazard despite `userService` being declared after.
export const firebaseCoreServices: CoreServices = {
    users: {
        getUserData: (handle: string) => userService.getUserData(handle),
        getUserDataByUid: (uid: string) => userService.getUserDataByUid(uid),
        getUsersByIds: (...args: Parameters<CoreServices['users']['getUsersByIds']>) =>
            userService.getUsersByIds(...args),
        ensureUserExists: (...args: Parameters<CoreServices['users']['ensureUserExists']>) =>
            userService.ensureUserExists(...args),
    },
};

export const userService = new UserService(firebaseUserDependencies, logger);

// AudioPostService — Antiphony canonical `dev.antiphony.audio.post` model.
// Self-contained: it owns its own dependencies binding. The binding routes
// author hydration through `firebaseCoreServices.users`.
export const audioPostService = new AudioPostService(firebaseAudioPostDependencies);

/**
 * Firebase-wired StorageService. Not part of CoreServices (none of the core
 * services call it as a peer), so constructed directly via the factory.
 * Shape mirrors apps/web's StorageService export — `StorageService.uploadFile(...)`,
 * `StorageService.getSignedUrl(...)`, `StorageService.extractObjectPath(...)`.
 */
export const StorageService = makeStorageService(firebaseBlobStore);
