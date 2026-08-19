import { describe, it, expect } from 'vitest';
import { createServices, readRuntimeEnv, servicesFor } from './composition.js';

/**
 * The composition root.
 *
 * This used to be two files. `composition.test.ts` imported `native.js` to
 * install the Firestore/GCS arm for its whole module graph, and this file
 * existed precisely because that import could not be undone within one vitest
 * module registry — so the with-fallback and without-fallback states needed
 * separate files to be asserted honestly.
 *
 * There is one state now. The fallback arm and `native.js` are gone, so the
 * suites merged back together and the property under test simplified: a
 * missing binding is an ERROR, always, everywhere. That was already true on a
 * Worker (no Application Default Credentials, so the fallback could not have
 * reached Firestore anyway); it is now true under Node too, because there is
 * nothing else left to reach.
 */

const DB = 'postgresql://user:pass@ep-test.us-east-1.aws.neon.tech/antiphony';
const fakeR2 = { get: async () => null, put: async () => ({}), head: async () => null };

describe('composition root — bindings are required', () => {
    it('refuses to compose with nothing bound', () => {
        expect(() => createServices({})).toThrow(/no blob store available.*BLOBS/s);
    });

    it('refuses to compose with a database but no bucket', () => {
        expect(() => createServices({ databaseUrl: DB })).toThrow(/BLOBS/);
    });

    it('refuses to compose with a bucket but no database', () => {
        expect(() =>
            createServices({ r2Bucket: fakeR2, r2BucketName: 'antiphony-r2-bucket' }),
        ).toThrow(/no database available.*HYPERDRIVE/s);
    });

    it('composes on Postgres + R2, and exposes the SQL handle for the sweep', () => {
        const services = createServices({
            databaseUrl: DB,
            r2Bucket: fakeR2,
            r2BucketName: 'antiphony-r2-bucket',
        });

        expect(services.backend).toBe('postgres');
        // The cron reaches `antiphony_sweep_expired()` through this. Absent, the
        // sweep silently no-ops — which is the state that shipped with the
        // schema and is exactly what this migration step closes.
        expect(services.sql).toBeDefined();
        expect(services.storage.extractObjectPath('r2://antiphony-r2-bucket/blobs/a/c')).toBe(
            'blobs/a/c',
        );
    });
});

describe('rate limiting selects on its own axis', () => {
    it('prefers the Durable Object over the Postgres table when bound', async () => {
        // The other four stores move together because they are one record
        // store seen from four angles. This one does not: the `rate_limits`
        // table is explicitly a bridge (db/schema.sql says so) and the Durable
        // Object is the destination. Selecting it on the database's axis would
        // mean the last step of the migration needed its own cutover instead
        // of just attaching the binding.
        //
        // Asserted by behaviour rather than identity: the Postgres store would
        // reach for `sql.query`, the Durable Object store routes through
        // `idFromName`.
        let routed: string | undefined;
        const services = createServices({
            databaseUrl: DB,
            r2Bucket: fakeR2,
            r2BucketName: 'antiphony-r2-bucket',
            rateLimiter: {
                idFromName: (name: string) => {
                    routed = name;
                    return {};
                },
                get: () => ({ fetch: async () => Response.json({ over: false }) }),
            },
        });

        await services.rateLimitStore.hit('ratelimit_1.2.3.4', { limit: 1, windowMs: 1000 });

        expect(routed).toBe('ratelimit_1.2.3.4');
        // ...and the records backend is unaffected by that choice.
        expect(services.backend).toBe('postgres');
    });

    it('falls back to the database-backed store without the binding', async () => {
        const services = createServices({
            databaseUrl: DB,
            r2Bucket: fakeR2,
            r2BucketName: 'antiphony-r2-bucket',
        });

        // No binding, so this is the Postgres store — which cannot reach a
        // database here and reports `unavailable` rather than throwing, per
        // the port.
        await expect(
            services.rateLimitStore.hit('k', { limit: 1, windowMs: 1000 }),
        ).resolves.toBe('unavailable');
    });
});

/**
 * `readRuntimeEnv` — carried over from the file this one absorbed. It reads
 * bindings and never composes, so it was never affected by which arm was
 * installed; it lived in the other file only because that is where the rest of
 * the selection suite was.
 */
describe('readRuntimeEnv', () => {
    it('prefers Hyperdrive over a raw connection string', () => {
        // Hyperdrive hands back a LOCAL pooled string, not the Neon
        // credential — which is why the database never becomes a Worker
        // secret. If a raw DATABASE_URL ever won here, that property would
        // silently stop holding.
        const env = readRuntimeEnv({
            HYPERDRIVE: { connectionString: 'postgresql://local/pooled' },
            DATABASE_URL: DB,
        });
        expect(env.databaseUrl).toBe('postgresql://local/pooled');
    });

    it('accepts a raw DATABASE_URL when Hyperdrive is absent', () => {
        expect(readRuntimeEnv({ DATABASE_URL: DB }).databaseUrl).toBe(DB);
    });

    it('ignores a non-binding value in the R2 slot', () => {
        // A string there means someone set an env var where a binding belongs.
        // Building the R2 store around it would fail later, deep in a request;
        // reporting it absent is the honest response, and now that there is no
        // fallback arm it surfaces immediately as a missing-binding throw.
        expect(readRuntimeEnv({ BLOBS: 'antiphony-r2-bucket' }).r2Bucket).toBeUndefined();
    });

    it('defaults the bucket name', () => {
        expect(readRuntimeEnv({}).r2BucketName).toBe('antiphony-r2-bucket');
    });
});

describe('memoisation', () => {
    /** A fully-bound env, since composing now requires both halves. */
    const bound = () => ({ DATABASE_URL: DB, BLOBS: fakeR2 });

    it('builds once per env object', () => {
        // A Worker's env is stable for the isolate's lifetime, so services
        // must survive between requests — a connection pool rebuilt per
        // request would be worse than the module singletons this replaced.
        const env = bound();
        expect(servicesFor(env)).toBe(servicesFor(env));
    });

    it('builds separately for different envs', () => {
        expect(servicesFor(bound())).not.toBe(servicesFor(bound()));
    });
});
