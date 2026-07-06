import { UserService } from '@antiphony/core/services/users';
import { AudioPostService } from '@antiphony/core/services/audio-posts';
import { makeStorageService } from '@antiphony/core/services/storage';
import { firebaseUserDependencies } from './users-dependencies.js';
import { firebaseAudioPostDependencies } from './audio-posts-dependencies.js';
import { firebaseBlobStore } from './storage-dependencies.js';
import { logger } from '../../../lib/logger.js';

/**
 * Firebase-wired service singletons for core-api.
 *
 * The canonical surface is the Antiphony audio-post model (`AudioPostService`)
 * plus the user-identity primitives the `/system/*` routes need
 * (`UserService`). Post-view authors are opaque `authorId`/`authorDid` refs,
 * so there's no cross-service author hydration — the former `CoreServices`
 * aggregate was retired with the public-profile projection (see
 * specs/core-surface.md).
 *
 * Note: no React `cache()` wrappers (unlike apps/web's binding). Core-api
 * isn't an RSC runtime.
 */

export const userService = new UserService(firebaseUserDependencies, logger);

// AudioPostService — Antiphony canonical `dev.antiphony.audio.post` model.
// Self-contained: it owns its own dependencies binding.
export const audioPostService = new AudioPostService(firebaseAudioPostDependencies);

/**
 * Firebase-wired StorageService. Not part of CoreServices (none of the core
 * services call it as a peer), so constructed directly via the factory.
 * Shape mirrors apps/web's StorageService export — `StorageService.uploadFile(...)`,
 * `StorageService.getSignedUrl(...)`, `StorageService.extractObjectPath(...)`.
 */
export const StorageService = makeStorageService(firebaseBlobStore);
