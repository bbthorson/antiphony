import { AudioPostService } from '@antiphony/core/services/audio-posts';
import { makeStorageService } from '@antiphony/core/services/storage';
import { firebaseAudioPostDependencies } from './audio-posts-dependencies.js';
import { firebaseBlobStore } from './storage-dependencies.js';

/**
 * Firebase-wired service singletons for core-api.
 *
 * The canonical surface is the Antiphony audio-post model (`AudioPostService`).
 * Post-view authors are opaque `authorId`/`authorDid` refs, so there's no
 * cross-service author hydration — the former `CoreServices` aggregate was
 * retired with the public-profile projection (see specs/core-surface.md).
 *
 * `UserService` and its `users`/`handles` bindings were retired alongside it:
 * their only callers were the `/system/atproto-*` identity routes, which the
 * Vox Pop BFF re-homed and which are now deleted. Antiphony holds no user
 * record at all — authorship is the opaque `authorId` facet on a post and
 * nothing more, which is exactly the boundary
 * specs/core-bff-boundary.md draws.
 *
 * Note: no per-request memoization wrappers — core-api is a plain HTTP
 * service, not an RSC runtime.
 */

// AudioPostService — Antiphony canonical `dev.antiphony.audio.post` model.
// Self-contained: it owns its own dependencies binding.
export const audioPostService = new AudioPostService(firebaseAudioPostDependencies);

/**
 * Firebase-wired StorageService. Not part of CoreServices (none of the core
 * services call it as a peer), so constructed directly via the factory.
 * Exposed as a const-object — `StorageService.uploadFile(...)`,
 * `StorageService.getSignedUrl(...)`, `StorageService.extractObjectPath(...)`.
 */
export const StorageService = makeStorageService(firebaseBlobStore);
