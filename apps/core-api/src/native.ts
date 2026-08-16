import { installFallbackBackends } from './composition.js';
import { installNativeProviders } from './lib/provider-registry.js';
import { installDurableDispatcher } from './lib/audio-processing.js';
import { logger } from './lib/logger.js';

import { firebaseBlobStore } from './adapters/outbound/firebase/storage-dependencies.js';
import { firebaseAudioPostDependencies } from './adapters/outbound/firebase/audio-posts-dependencies.js';
import { firebaseAudioProcessingDependencies } from './adapters/outbound/firebase/audio-processing-dependencies.js';
import { firebaseRateLimitStore } from './adapters/outbound/firebase/rate-limit-store.js';
import { firebaseIdempotencyStore } from './adapters/outbound/firebase/idempotency-store.js';

import { ffmpegTrimmer } from './adapters/outbound/ffmpeg/trimmer.js';
import { ffmpegWaveform } from './adapters/outbound/ffmpeg/waveform.js';
import { ffmpegAvailable } from './adapters/outbound/ffmpeg/run.js';

import { cloudTasksResolver } from './adapters/outbound/dispatch/cloud-tasks.js';

/**
 * Everything this service can do on Node that it cannot do on Workers, wired in
 * one place.
 *
 * ## Why this file exists
 *
 * `app.ts` and every route handler are shared by both runtimes, and a Worker
 * bundle has no `external` escape hatch — whatever the module graph reaches has
 * to bundle and has to run. Three dependencies cannot:
 *
 *   - **`firebase-admin`** — CommonJS with native transitive deps (grpc,
 *     protobufjs). Already `external` in `esbuild.config.mjs` for the same
 *     reason.
 *   - **`ffmpeg-static` / `node:child_process`** — `nodejs_compat` does not
 *     provide `child_process`, and `ffmpeg-static` resolves its binary through
 *     `__dirname` at module scope, which does not exist in a bundle. (The
 *     esbuild config's `__dirname` leak check exists because that already
 *     shipped once.)
 *   - **`google-auth-library`** — reaches the GCE metadata server for
 *     Application Default Credentials, which a Worker does not have.
 *
 * Every one of them is reachable today from `app.ts` through the composition
 * root, the provider registry, or the dispatch seam. Rather than aliasing them
 * to stubs at build time — which would make a Worker's failure a runtime throw
 * from inside a dependency, deep in a request — each seam takes its native half
 * by INSTALLATION, and this file is the only importer of any of them.
 *
 * ## Import it for side effects, first, from the Node entry only
 *
 *     import './native.js';
 *
 * The installs must happen before anything calls `servicesFor()`, which is why
 * `index.ts` imports this above everything else. `installFallbackBackends`
 * drops the memoised service graph on its way through, so an early build
 * cannot survive as a stale one — but relying on that would be relying on a
 * safety net rather than on order.
 *
 * ## What a Worker gets instead
 *
 * Nothing here, deliberately. Bindings are mandatory rather than optional
 * there (`composition.ts` throws on a missing one), `trim` and `waveform`
 * resolve unavailable and settle `skipped` until step 4 moves them onto the
 * rendition service, and durable dispatch comes from the Queues binding.
 * See specs/cloudflare-migration.md § Sequencing.
 */

installFallbackBackends({
    blob: firebaseBlobStore,
    audioPostDeps: firebaseAudioPostDependencies,
    audioProcessingDeps: firebaseAudioProcessingDependencies,
    rateLimitStore: firebaseRateLimitStore,
    idempotencyStore: firebaseIdempotencyStore,
});

// One probe governs both stages — the coupling is real (one binary, two
// stages) and is expressed by sharing `ffmpegAvailable`, not by sharing a
// branch, so the two remain independently selectable.
installNativeProviders({
    trimmer: { name: 'ffmpeg', available: ffmpegAvailable, create: () => ffmpegTrimmer },
    waveform: { name: 'ffmpeg', available: ffmpegAvailable, create: () => ffmpegWaveform },
});

installDurableDispatcher(cloudTasksResolver(logger));
