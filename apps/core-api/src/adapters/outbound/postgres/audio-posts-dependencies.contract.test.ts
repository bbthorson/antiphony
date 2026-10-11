import { vi } from 'vitest';
import { audioPostDependenciesContract } from '@antiphony/core/testing/audio-post-dependencies.contract';
import { createTestDatabase, type TestDatabase } from './testing/pglite.js';
import { postgresAudioPostDependencies } from './audio-posts-dependencies.js';
import { postgresSpaceDependencies } from './space-dependencies.js';

// `getAppDid` reads the boot-validated pin snapshot, which is not under test.
vi.mock('../../../lib/app-did.js', () => ({
    getAppDid: () => 'did:web:vox-pop.example',
}));

// The Postgres binding against the same contract the in-memory store the
// service tests use runs (packages/core/testing/), so the two cannot drift
// apart without one of them failing.
let db: TestDatabase;

audioPostDependenciesContract('postgres', {
    async setup() {
        db = await createTestDatabase();
        return {
            deps: postgresAudioPostDependencies(db, { stat: async () => null }),
            async seedSpace(originAppId, key) {
                await postgresSpaceDependencies(db).putSpace({
                    originAppId,
                    key,
                    readPolicy: 'managing-app',
                    writePolicy: 'managing-app',
                });
            },
        };
    },
    reset: () => db.truncate(),
    teardown: () => db.close(),
});
