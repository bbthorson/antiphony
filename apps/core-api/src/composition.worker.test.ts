import { describe, it, expect } from 'vitest';
import { createServices } from './composition.js';

/**
 * The composition root WITHOUT the Firebase fallback — i.e. what a Worker gets.
 *
 * Deliberately its own file, and deliberately does not import `native.js`.
 * `composition.test.ts` installs the fallback for its whole module graph, so
 * the two states cannot be asserted in one file; vitest gives each test file
 * its own module registry, which is what keeps these honest.
 *
 * The property under test is that a missing binding is an ERROR here rather
 * than a fall-through. On Cloud Run, falling back to Firestore is the correct
 * and intended behaviour — it is the cutover switch. On a Worker it would be a
 * trap: there are no Application Default Credentials, so the fallback could not
 * reach Firestore anyway, and pretending otherwise turns one loud startup
 * failure into a confusing per-request one much later.
 */

const DB = 'postgresql://user:pass@ep-test.us-east-1.aws.neon.tech/antiphony';
const fakeR2 = { get: async () => null, put: async () => ({}), head: async () => null };

describe('composition root — no fallback installed (Worker)', () => {
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
