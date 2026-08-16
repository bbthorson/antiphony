import { describe, it, expect, vi } from 'vitest';
// Installs the Firebase bindings as the fallback, the way `index.ts` does under
// Node. Without it every assertion about Firebase below describes a Worker
// instead, where an unbound backend throws rather than falling through. That
// half is asserted in `composition.worker.test.ts`, which has to be a separate
// file because this import is module-graph-wide.
import './native.js';
import { createServices, readRuntimeEnv, servicesFor } from './composition.js';

vi.mock('./lib/firebase-admin.js', () => ({
    getAdminDb: () => ({}),
    getAdmin: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

/**
 * Backend selection.
 *
 * Worth its own suite because this is the cutover switch. The Firestore → Neon
 * move is a configuration change, so "does config X actually produce backend Y"
 * is the question a deploy rests on — and it was previously unanswerable,
 * because the bindings were fixed at module load.
 */

const DB = 'postgresql://user:pass@ep-test.us-east-1.aws.neon.tech/antiphony';

/** Minimal R2 binding — selection only checks for a callable `get`. */
const fakeR2 = { get: async () => null, put: async () => ({}), head: async () => null };

describe('composition root', () => {
    describe('backend selection', () => {
        it('defaults to Firebase when nothing is bound', () => {
            expect(createServices({}).backend).toBe('firebase');
        });

        it('selects Postgres when a database URL is present', () => {
            expect(createServices({ databaseUrl: DB }).backend).toBe('postgres');
        });

        it('selects storage INDEPENDENTLY of the database', () => {
            // The migration moves records (2d) and blobs (Super Slurper) in
            // separate steps, so Neon-with-GCS-blobs is a valid intermediate
            // state. Coupling the choice would force one big-bang cutover.
            const recordsOnly = createServices({ databaseUrl: DB });
            expect(recordsOnly.backend).toBe('postgres');
            // R2 absent ⇒ Firebase blob store, which does not know `r2://`.
            expect(recordsOnly.storage.extractObjectPath('r2://b/blobs/a/c')).toBeNull();

            const both = createServices({
                databaseUrl: DB,
                r2Bucket: fakeR2,
                r2BucketName: 'antiphony-r2-bucket',
            });
            expect(both.storage.extractObjectPath('r2://antiphony-r2-bucket/blobs/a/c')).toBe(
                'blobs/a/c',
            );
        });

        it('can run R2 blobs against Firestore records', () => {
            // The mirror case: blobs migrated first, records still on Firestore.
            const s = createServices({ r2Bucket: fakeR2, r2BucketName: 'antiphony-r2-bucket' });
            expect(s.backend).toBe('firebase');
            expect(s.storage.extractObjectPath('r2://antiphony-r2-bucket/blobs/a/c')).toBe(
                'blobs/a/c',
            );
        });
    });

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
            // A string there means someone set an env var where a binding
            // belongs. Building the R2 store around it would fail later, deep
            // in a request; falling back is the honest response.
            expect(readRuntimeEnv({ BLOBS: 'antiphony-r2-bucket' }).r2Bucket).toBeUndefined();
        });

        it('defaults the bucket name', () => {
            expect(readRuntimeEnv({}).r2BucketName).toBe('antiphony-r2-bucket');
        });
    });

    describe('memoisation', () => {
        it('builds once per env object', () => {
            // A Worker's env is stable for the isolate's lifetime, so services
            // must survive between requests — a connection pool rebuilt per
            // request would be worse than the module singletons this replaced.
            const env = { DATABASE_URL: DB };
            expect(servicesFor(env)).toBe(servicesFor(env));
        });

        it('builds separately for different envs', () => {
            expect(servicesFor({ DATABASE_URL: DB })).not.toBe(
                servicesFor({ DATABASE_URL: DB }),
            );
        });
    });
});
