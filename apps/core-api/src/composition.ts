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
 * ## One backend, selected from bindings
 *
 * Records live in Postgres and blobs in R2; there is no second arm to choose
 * between any more. What this still decides is whether the bindings a
 * deployment actually supplied are enough to build a working graph, and it
 * fails loudly here — at graph construction — rather than per request.
 *
 * The Firestore/GCS arm and the `src/native.ts` entry that installed it are
 * gone. They survived the cutover only to keep the pre-migration data readable;
 * the records migration turned out to be a no-op (specs/archive/cloudflare-migration.md
 * § Step 2 — nothing had ever been written through `/api/v1/posts`) and blobs
 * moved by Super Slurper, so nothing reads Firestore now.
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
    /**
     * The raw SQL handle. Present for maintenance work that is not a domain
     * operation and so has no port to reach through — today only the TTL sweep
     * the Worker's cron drives.
     */
    sql: SqlClient;
    /**
     * The transcode backend, when this deployment has one configured.
     *
     * `undefined` is a supported state, not a broken one: without it the audio
     * proxy serves renditions that already exist and 404s the rest, which is
     * correct for a deployment that pre-warms every rendition it needs (or
     * wants none). See ports/rendition-service.ts.
     */
    renditionService?: RenditionServicePort;
    /**
     * Which backend got wired — for `/health` and for log context.
     *
     * Only one value is possible now that the Firestore arm is gone. It stays a
     * field rather than becoming a literal at the call site because `/health`
     * publishes it, and "which store is this deployment on" is the question the
     * migration made worth asking out loud.
     */
    backend: 'postgres';
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
    // credential — and is preferred here for that reason. Nothing binds it
    // today: an HTTPS-derived-from-hostname driver cannot talk to a string that
    // points into Cloudflare's network, so the deployed Worker takes
    // `DATABASE_URL` as a secret instead. See specs/archive/cloudflare-migration.md
    // § Verified deploy blockers. This preference stays because it is the
    // correct order the moment the driver can use it (option B), and because
    // inverting it would make a future Hyperdrive binding silently dead config.
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

/** What a deployment is missing when it has not bound a required resource. */
function missingBinding(what: string, binding: string): Error {
    return new Error(
        `[composition] no ${what} available: bind ${binding}. See specs/archive/cloudflare-migration.md § Secrets.`,
    );
}

/**
 * Build the service graph for one environment.
 *
 * Storage and the database are still read independently — they are separate
 * bindings and a deployment can get one wrong without the other — but both are
 * now required. The migration-era state where blobs were still on GCS while
 * records had moved is over, so there is nothing to fall back to and a missing
 * binding is an error.
 */
export function createServices(env: RuntimeEnv): Services {
    const blob: BlobStore =
        env.r2Bucket && env.r2BucketName
            ? r2BlobStore({ bucket: env.r2Bucket, bucketName: env.r2BucketName })
            : raise(missingBinding('blob store', 'BLOBS'));

    const storage = makeStorageService(blob);

    const sql: SqlClient = env.databaseUrl
        ? neonSqlClient(env.databaseUrl)
        : raise(missingBinding('database', 'DATABASE_URL (or HYPERDRIVE)'));

    // Rate limiting is selected on its OWN axis, ahead of the database.
    //
    // The other four stores are one record store seen from four angles. This one
    // is not: it is a counter on the read path, the table in `db/schema.sql` is
    // explicitly a bridge rather than a destination, and the Durable Object is
    // where it is going. So a deployment WITH the binding attached should
    // already be using the binding — otherwise the last step of the migration
    // would need its own cutover instead of just attaching the thing.
    const rateLimitStore = env.rateLimiter
        ? durableObjectRateLimitStore(env.rateLimiter)
        : postgresRateLimitStore(sql);

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

    const audioPostDeps = postgresAudioPostDependencies(sql);

    return {
        audioPostService: new AudioPostService(audioPostDeps),
        storage,
        audioPostDeps,
        audioProcessingDeps: postgresAudioProcessingDependencies(sql, storage),
        idempotencyStore: postgresIdempotencyStore(sql),
        sql,
        backend: 'postgres',
        rateLimitStore,
        renditionService: rendition.config
            ? httpRenditionService(rendition.config, logger)
            : undefined,
    };
}

/** Throw from an expression position, so the selections above stay expressions. */
function raise(err: Error): never {
    throw err;
}

const cache = new WeakMap<object, Services>();
/** Slot for Node, where there is no env object to key the WeakMap on. */
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

