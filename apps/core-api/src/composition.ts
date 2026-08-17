import { AudioPostService } from '@antiphony/core/services/audio-posts';
import { makeStorageService, type StorageService } from '@antiphony/core/services/storage';
import type { AudioPostDependencies } from '@antiphony/core/ports/audio-posts-dependencies';
import type { AudioProcessingDependencies } from '@antiphony/core/ports/audio-processing-dependencies';
import type { BlobStore } from '@antiphony/core/ports/storage-dependencies';

import { r2BlobStore } from './adapters/outbound/r2/blob-store.js';
import type { R2BucketLike } from './adapters/outbound/r2/bucket.js';
import {
    durableObjectRateLimitStore,
    type DurableObjectNamespaceLike,
} from './adapters/outbound/durable-objects/rate-limiter.js';
import {
    httpRenditionService,
    renditionServiceConfig,
} from './adapters/outbound/rendition/http.js';
import type { RenditionServicePort } from './ports/rendition-service.js';
import { logger } from './lib/logger.js';
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
 *
 * ## Why the Firebase half is injected rather than imported
 *
 * Selection logic all lives here — that is what makes this a composition root.
 * What does NOT live here any more is the Firebase adapters themselves, because
 * importing them puts `firebase-admin` in the module graph of every route and
 * therefore in the Worker bundle. It cannot go there: it is CommonJS with
 * native transitive dependencies (grpc, protobufjs), which is why
 * `esbuild.config.mjs` has always kept it `external`. A Worker bundle has no
 * `external` — whatever the graph reaches has to bundle.
 *
 * So the concrete Firebase objects arrive through `installFallbackBackends`,
 * called by `src/native.ts`, which only the Node entry imports. The branch
 * structure below is unchanged; the Worker simply runs with no fallback
 * installed, where a missing binding is an error rather than a fall-through.
 * That is the right behaviour there independently of bundling: a Worker holds
 * no Application Default Credentials and could not reach Firestore if it tried,
 * so falling back would trade one loud failure for a confusing per-request one.
 */

export interface Services {
    audioPostService: AudioPostService;
    storage: StorageService;
    audioPostDeps: AudioPostDependencies;
    audioProcessingDeps: AudioProcessingDependencies;
    rateLimitStore: RateLimitStore;
    idempotencyStore: IdempotencyStore;
    /**
     * The raw SQL handle, when Postgres is the backend. Present for maintenance
     * work that is not a domain operation and so has no port to reach through —
     * today only the TTL sweep the Worker's cron drives. `undefined` on
     * Firestore, which has native TTL and needs no sweep.
     */
    sql?: SqlClient;
    /**
     * The transcode backend, when this deployment has one configured.
     *
     * `undefined` is a supported state, not a broken one: without it the audio
     * proxy serves renditions that already exist and 404s the rest, which is
     * correct for a deployment that pre-warms every rendition it needs (or
     * wants none). See ports/rendition-service.ts.
     */
    renditionService?: RenditionServicePort;
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
    /** Durable Object namespace backing rate-limit buckets. Worker only. */
    rateLimiter?: DurableObjectNamespaceLike;
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
    const rateLimiter = bindings.RATE_LIMITER as DurableObjectNamespaceLike | undefined;

    return {
        databaseUrl: databaseUrl || undefined,
        r2Bucket: r2Bucket && typeof r2Bucket.get === 'function' ? r2Bucket : undefined,
        r2BucketName:
            (typeof bindings.ANTIPHONY_R2_BUCKET === 'string'
                ? bindings.ANTIPHONY_R2_BUCKET
                : undefined) ?? R2_BUCKET_NAME,
        // Probed the same way as the R2 binding: a value in the slot that is
        // not the binding shape means someone set a var where a binding
        // belongs, and building the store around it would fail later, inside a
        // request, on the read path.
        rateLimiter:
            rateLimiter && typeof rateLimiter.idFromName === 'function' ? rateLimiter : undefined,
    };
}

/**
 * The Firebase-backed halves, supplied by the Node entry point.
 *
 * `audioProcessingDeps` is a function because that binding closes over the
 * `StorageService`, which is itself the result of a selection made above it —
 * so it cannot be constructed until the blob store is chosen.
 */
export interface FallbackBackends {
    blob: BlobStore;
    audioPostDeps: AudioPostDependencies;
    audioProcessingDeps: (storage: StorageService) => AudioProcessingDependencies;
    rateLimitStore: RateLimitStore;
    idempotencyStore: IdempotencyStore;
}

let fallbackBackends: FallbackBackends | undefined;

/**
 * Register the Firebase-backed bindings as the fallback for anything this
 * environment has not bound natively. Called once, at import time, by
 * `src/native.ts`. See § Why the Firebase half is injected.
 */
export function installFallbackBackends(backends: FallbackBackends): void {
    fallbackBackends = backends;
    // Anything already built was built without the fallback and may have
    // resolved differently. Nothing should have been built this early, but if
    // it was, a stale graph is the kind of bug that surfaces as one route
    // talking to the wrong store.
    resetServices();
}

/** What a deployment is missing when it has neither a binding nor a fallback. */
function missingBinding(what: string, binding: string): Error {
    return new Error(
        `[composition] no ${what} available: bind ${binding}, or run under Node with the Firebase fallback installed (src/native.ts). See specs/cloudflare-migration.md § Secrets.`,
    );
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
    const fallback = fallbackBackends;

    const r2 =
        env.r2Bucket && env.r2BucketName
            ? r2BlobStore({ bucket: env.r2Bucket, bucketName: env.r2BucketName })
            : undefined;
    const blob: BlobStore = r2 ?? fallback?.blob ?? raise(missingBinding('blob store', 'BLOBS'));

    const storage = makeStorageService(blob);

    const sql: SqlClient | undefined = env.databaseUrl
        ? neonSqlClient(env.databaseUrl)
        : undefined;

    // Grouped rather than four parallel ternaries so the two halves cannot
    // drift into a mixed graph — `backend` is reported on `/health` and has to
    // describe every one of these, not just the first.
    const db = sql
        ? {
              audioPostDeps: postgresAudioPostDependencies(sql),
              audioProcessingDeps: postgresAudioProcessingDependencies(sql, storage),
              rateLimitStore: postgresRateLimitStore(sql),
              idempotencyStore: postgresIdempotencyStore(sql),
              sql,
              backend: 'postgres' as const,
          }
        : fallback
          ? {
                audioPostDeps: fallback.audioPostDeps,
                audioProcessingDeps: fallback.audioProcessingDeps(storage),
                rateLimitStore: fallback.rateLimitStore,
                idempotencyStore: fallback.idempotencyStore,
                backend: 'firebase' as const,
            }
          : raise(missingBinding('database', 'HYPERDRIVE'));

    // Rate limiting is selected on its OWN axis, ahead of the database.
    //
    // The other four stores move together because they are one record store
    // seen from four angles. This one is not: it is a counter on the read path,
    // the table in `db/schema.sql` is explicitly a bridge rather than a
    // destination, and the Durable Object is where it is going. So a deployment
    // on Postgres WITH the binding attached should already be using the binding
    // — otherwise the last step of the migration would need its own cutover
    // instead of just attaching the thing.
    const rateLimitStore = env.rateLimiter
        ? durableObjectRateLimitStore(env.rateLimiter)
        : db.rateLimitStore;

    // Read off `process.env` rather than a binding, so it is configured the
    // same way on both runtimes — the service is reached over HTTPS with a
    // bearer either way, and there is no binding that would make it otherwise.
    //
    // A PARTIAL config is deliberately not a silent opt-out: a URL with no token
    // produces a service call that 401s on every miss, which looks configured
    // and never succeeds. Reported once here, at graph-construction time, rather
    // than per request.
    const rendition = renditionServiceConfig();
    if (!rendition.config && rendition.missing.length === 1) {
        logger.error(
            { missing: rendition.missing },
            '[rendition] partially configured — on-demand renditions are OFF; pre-warmed ones still serve',
        );
    }

    return {
        audioPostService: new AudioPostService(db.audioPostDeps),
        storage,
        ...db,
        rateLimitStore,
        renditionService: rendition.config
            ? httpRenditionService(rendition.config, logger)
            : undefined,
    };
}

/** Throw from an expression position, so the `??` chain above stays a chain. */
function raise(err: Error): never {
    throw err;
}

let cache = new WeakMap<object, Services>();
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

/**
 * Drop the memoised graphs so the next `servicesFor` rebuilds. Called when the
 * fallback lands: anything built before it resolved against a different set of
 * options, and a stale graph shows up as one route talking to the wrong store.
 */
function resetServices(): void {
    nodeServices = undefined;
    // Reassigned rather than cleared: a WeakMap has no `clear()`.
    cache = new WeakMap<object, Services>();
}
