import { AudioPostService } from '@antiphony/core/services/audio-posts';
import { makeStorageService, type StorageService } from '@antiphony/core/services/storage';
import type { AudioPostDependencies } from '@antiphony/core/ports/audio-posts-dependencies';
import type { AudioProcessingDependencies } from '@antiphony/core/ports/audio-processing-dependencies';
import type { BlobStore } from '@antiphony/core/ports/storage-dependencies';

import { firebaseBlobStore } from './adapters/outbound/firebase/storage-dependencies.js';
import { firebaseAudioPostDependencies } from './adapters/outbound/firebase/audio-posts-dependencies.js';
import { firebaseAudioProcessingDependencies } from './adapters/outbound/firebase/audio-processing-dependencies.js';
import { firebaseRateLimitStore } from './adapters/outbound/firebase/rate-limit-store.js';
import { firebaseIdempotencyStore } from './adapters/outbound/firebase/idempotency-store.js';

import { r2BlobStore } from './adapters/outbound/r2/blob-store.js';
import type { R2BucketLike } from './adapters/outbound/r2/bucket.js';
import { neonSqlClient } from './adapters/outbound/postgres/client.js';
import { postgresAudioPostDependencies } from './adapters/outbound/postgres/audio-posts-dependencies.js';
import { postgresAudioProcessingDependencies } from './adapters/outbound/postgres/audio-processing-dependencies.js';
import { postgresRateLimitStore } from './adapters/outbound/postgres/rate-limit-store.js';
import { postgresIdempotencyStore } from './adapters/outbound/postgres/idempotency-store.js';

import type { RateLimitStore } from './ports/rate-limit-store.js';
import type { IdempotencyStore } from './ports/idempotency-store.js';
import type { SqlClient } from './ports/sql-client.js';
import { R2_BUCKET_NAME } from './lib/app-config.js';

/**
 * The composition root — the one place that decides which bindings back the
 * ports, and the only module that knows both halves exist.
 *
 * ## This is the cutover switch, not just Worker preparation
 *
 * Before this, `core-services-firebase.ts` constructed Firebase singletons at
 * module load, so there was no way to run the Postgres and R2 bindings in
 * production at all — they were tested code with no route to production. The
 * backend is now chosen from configuration, which makes the migration a
 * deploy-time flag flip and, more importantly, makes rolling BACK one too.
 *
 * ## Why a factory rather than module singletons
 *
 * A Worker receives its bindings on the `env` argument to `fetch(request, env,
 * ctx)`. They do not exist at module-evaluation time and cannot, because a
 * single deployed script serves multiple environments. Module-scoped
 * construction is therefore not a style preference to preserve — it is
 * incompatible with the destination runtime.
 *
 * Under Node the same factory reads `process.env`, so both runtimes are served
 * without either being special-cased at a call site.
 *
 * ## Memoised per environment, not per request
 *
 * `servicesFor` caches on the identity of the env object in a `WeakMap`. In a
 * Worker that object is stable for the isolate's lifetime, so services are
 * built once and a connection pool or a validated snapshot survives between
 * requests — which is the behaviour the module-scoped version had by accident
 * and this keeps on purpose. A `WeakMap` rather than a plain cache so a
 * short-lived env (tests, one-off scripts) is collectable.
 */

export interface Services {
    audioPostService: AudioPostService;
    storage: StorageService;
    audioPostDeps: AudioPostDependencies;
    audioProcessingDeps: AudioProcessingDependencies;
    rateLimitStore: RateLimitStore;
    idempotencyStore: IdempotencyStore;
    /** Which backend actually got wired — for `/health` and for log context. */
    backend: 'firebase' | 'postgres';
}

/**
 * Everything the composition root reads, gathered so the two runtimes differ in
 * ONE function rather than at every lookup.
 *
 * `R2Bucket` and `Hyperdrive` arrive as live binding objects in a Worker and are
 * simply absent under Node — which is also the selection signal, so there is no
 * separate `ANTIPHONY_BACKEND=postgres` flag to keep in sync with the bindings
 * that would have to be present for it to mean anything. A deployment cannot
 * ask for Postgres and forget to attach the database.
 */
export interface RuntimeEnv {
    /** Postgres connection string. From Hyperdrive in a Worker, `DATABASE_URL` under Node. */
    databaseUrl?: string;
    /** R2 binding. Worker only. */
    r2Bucket?: R2BucketLike;
    r2BucketName?: string;
}

/**
 * Read a `RuntimeEnv` out of whatever the runtime handed us.
 *
 * A Worker's `env` carries binding OBJECTS (`env.BLOBS` is an R2Bucket,
 * `env.HYPERDRIVE` exposes `.connectionString`); Node has strings on
 * `process.env`. Both shapes are normalised here so nothing downstream branches
 * on runtime.
 */
export function readRuntimeEnv(env?: Record<string, unknown>): RuntimeEnv {
    const bindings = env ?? {};

    // Hyperdrive hands back a LOCAL pooled connection string — not the Neon
    // credential. That is the whole point of it, and the reason the database
    // never becomes a Worker secret. See specs/cloudflare-migration.md § Secrets.
    const hyperdrive = bindings.HYPERDRIVE as { connectionString?: string } | undefined;
    const databaseUrl =
        hyperdrive?.connectionString ??
        (typeof bindings.DATABASE_URL === 'string' ? bindings.DATABASE_URL : undefined) ??
        (typeof process !== 'undefined' ? process.env.DATABASE_URL?.trim() : undefined) ??
        undefined;

    const r2Bucket = bindings.BLOBS as R2BucketLike | undefined;

    return {
        databaseUrl: databaseUrl || undefined,
        r2Bucket: r2Bucket && typeof r2Bucket.get === 'function' ? r2Bucket : undefined,
        r2BucketName:
            (typeof bindings.ANTIPHONY_R2_BUCKET === 'string'
                ? bindings.ANTIPHONY_R2_BUCKET
                : undefined) ?? R2_BUCKET_NAME,
    };
}

/**
 * Build the service graph for one environment.
 *
 * Storage and the database are selected INDEPENDENTLY. That is deliberate: the
 * migration moves them in separate steps (records in 2d, blobs via Super
 * Slurper), and coupling the choice would force a single big-bang cutover where
 * the design specifically allows two smaller ones. A deployment running Neon
 * with blobs still on GCS is a valid, expected intermediate state.
 */
export function createServices(env: RuntimeEnv): Services {
    const blob: BlobStore =
        env.r2Bucket && env.r2BucketName
            ? r2BlobStore({ bucket: env.r2Bucket, bucketName: env.r2BucketName })
            : firebaseBlobStore;

    const storage = makeStorageService(blob);

    let sql: SqlClient | undefined;
    if (env.databaseUrl) sql = neonSqlClient(env.databaseUrl);

    const audioPostDeps = sql
        ? postgresAudioPostDependencies(sql)
        : firebaseAudioPostDependencies;

    const audioProcessingDeps = sql
        ? postgresAudioProcessingDependencies(sql, storage)
        : firebaseAudioProcessingDependencies(storage);

    return {
        audioPostService: new AudioPostService(audioPostDeps),
        storage,
        audioPostDeps,
        audioProcessingDeps,
        rateLimitStore: sql ? postgresRateLimitStore(sql) : firebaseRateLimitStore,
        idempotencyStore: sql ? postgresIdempotencyStore(sql) : firebaseIdempotencyStore,
        backend: sql ? 'postgres' : 'firebase',
    };
}

const cache = new WeakMap<object, Services>();
/** Fallback slot for Node, where there is no env object to key on. */
let nodeServices: Services | undefined;

/**
 * The service graph for this environment, built once and reused.
 *
 * Call this from a handler rather than importing services directly — an import
 * binds at module load, which is exactly what a Worker cannot do.
 */
export function servicesFor(env?: Record<string, unknown>): Services {
    if (!env) {
        nodeServices ??= createServices(readRuntimeEnv());
        return nodeServices;
    }
    const hit = cache.get(env);
    if (hit) return hit;
    const built = createServices(readRuntimeEnv(env));
    cache.set(env, built);
    return built;
}

/** Test-only: drop the memoised graphs so a case can rewire the backend. */
export function resetServicesForTest(): void {
    nodeServices = undefined;
}
