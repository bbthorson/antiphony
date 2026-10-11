import { audioPostDependenciesContract } from './audio-post-dependencies.contract';
import { inMemoryAudioPostDependencies, spaceKeyOf, type InMemoryAudioPostDependencies } from './in-memory-audio-post-dependencies';

// The in-memory store against the same contract the Postgres binding runs
// (apps/core-api/src/adapters/outbound/postgres/audio-posts-dependencies.contract.test.ts).
let deps: InMemoryAudioPostDependencies;

audioPostDependenciesContract('in-memory', {
    async setup() {
        deps = inMemoryAudioPostDependencies();
        return {
            deps,
            async seedSpace(originAppId, key) {
                deps.spaces.add(spaceKeyOf(originAppId, key));
            },
        };
    },
    async reset() {
        deps.posts.clear();
        deps.spaces.clear();
        deps.blobs.clear();
        deps.transcripts.clear();
    },
});
