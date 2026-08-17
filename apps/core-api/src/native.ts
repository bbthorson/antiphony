import { installFallbackBackends } from './composition.js';
import { installDurableDispatcher } from './lib/audio-processing.js';
import { logger } from './lib/logger.js';

import { firebaseBlobStore } from './adapters/outbound/firebase/storage-dependencies.js';
import { firebaseAudioPostDependencies } from './adapters/outbound/firebase/audio-posts-dependencies.js';
import { firebaseAudioProcessingDependencies } from './adapters/outbound/firebase/audio-processing-dependencies.js';
import { firebaseRateLimitStore } from './adapters/outbound/firebase/rate-limit-store.js';
import { firebaseIdempotencyStore } from './adapters/outbound/firebase/idempotency-store.js';

import { cloudTasksResolver } from './adapters/outbound/dispatch/cloud-tasks.js';

/**
 * Everything this service can do on Node that it cannot do on Workers, wired in
 * one place.
 *
 * ## Why this file exists
 *
 * `app.ts` and every route handler are shared by both runtimes, and a Worker
 * bundle has no `external` escape hatch — whatever the module graph reaches has
 * to bundle and has to run. Two dependencies cannot:
 *
 *   - **`firebase-admin`** — CommonJS with native transitive deps (grpc,
 *     protobufjs).
 *   - **`google-auth-library`** — reaches the GCE metadata server for
 *     Application Default Credentials, which a Worker does not have.
 *
 * Both are reachable from `app.ts` through the composition root or the dispatch
 * seam. Rather than aliasing them to stubs at build time — which would make a
 * Worker's failure a runtime throw from inside a dependency, deep in a request —
 * each seam takes its native half by INSTALLATION, and this file is the only
 * importer of either.
 *
 * **`ffmpeg-static` used to be the third.** The trim and waveform adapters
 * reached it and `node:child_process`, so they had to be injected here too. They
 * are gone: the compute moved to `apps/audio-rendition` and the adapters became
 * a `fetch`, which is portable, so the provider registry declares them directly.
 * That is one fewer install seam and one fewer dependency — and unlike the two
 * above, those stages now WORK on Workers rather than being unavailable there.
 *
 * ## It has no runtime importer any more
 *
 * `src/index.ts` was the only one, and it went with the Cloud Run runtime. What
 * keeps this file alive is that the **Firestore data has not been migrated
 * yet**: `scripts/migrate-firestore-to-neon.ts` still has to read it, the
 * Firebase-backed bindings below are what the pre-migration data lives behind,
 * and their test suites are the only thing asserting those bindings still
 * behave. Deleting them before the migration runs would delete the description
 * of the data being migrated.
 *
 * So this is now a **test and migration-era** module, and it should go when the
 * records migration has run and been verified — along with the Firebase
 * adapters, `lib/firebase-admin.ts`, and the `firebase` arm of the composition
 * root. That is step 2 teardown, not step 3.
 *
 * Import it for side effects, before anything calls `servicesFor()`:
 *
 *     import './native.js';
 *
 * `installFallbackBackends` drops the memoised service graph on its way
 * through, so an early build cannot survive as a stale one — but relying on
 * that would be relying on a safety net rather than on order.
 *
 * ## What the Worker gets instead
 *
 * Nothing here, deliberately. Bindings are mandatory rather than optional there
 * (`composition.ts` throws on a missing one) and durable dispatch comes from the
 * Queues binding. `trim` and `waveform` are no longer on that list: they work on
 * Workers now, through the transcode service. See
 * specs/cloudflare-migration.md § Sequencing.
 */

installFallbackBackends({
    blob: firebaseBlobStore,
    audioPostDeps: firebaseAudioPostDependencies,
    audioProcessingDeps: firebaseAudioProcessingDependencies,
    rateLimitStore: firebaseRateLimitStore,
    idempotencyStore: firebaseIdempotencyStore,
});

installDurableDispatcher(cloudTasksResolver(logger));
