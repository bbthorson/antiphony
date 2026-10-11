import type { AudioPostRecord, TranscriptEnrichmentRecord } from 'shared/types/audio';
import type { SpaceKey, SpaceRecord } from 'shared/types/spaces';
import type {
    AudioPostDependencies,
    AudioPostQueryOptions,
    AudioPostThreadOptions,
} from '../ports/audio-posts-dependencies';

/**
 * An in-memory `AudioPostDependencies` that behaves like the Postgres binding
 * wherever the port leaves room to differ — held to it by
 * `audio-post-dependencies.contract.ts`, which both run. Service tests that
 * need stored state build on this rather than on a fake of their own, so what
 * they rely on is checked against the real store.
 *
 * The configuration-shaped methods (`getAppDid`, `resolveAudioUrl`,
 * `cidForRecord`, `now`, `newPostId`) take plain defaults; override them per
 * test.
 */
export interface InMemoryAudioPostDependencies extends AudioPostDependencies {
    /** Stored posts, keyed by id: as in Postgres, an id belongs to one tenant. */
    readonly posts: Map<string, AudioPostRecord>;
    /** Spaces that exist, as `{originAppId}/{type}/{skey}`. */
    readonly spaces: Set<string>;
    /** Stored blobs and their space, as `{originAppId}/{cid}`; null is public. */
    readonly blobs: Map<string, SpaceKey | null>;
    readonly transcripts: Map<string, TranscriptEnrichmentRecord>;
}

export const spaceKeyOf = (originAppId: string, k: SpaceKey) => `${originAppId}/${k.type}/${k.skey}`;

/** Postgres order: `(created_at, id)`, so equal timestamps still page stably. */
function compare(a: AudioPostRecord, b: AudioPostRecord): number {
    const t = a.createdAt.getTime() - b.createdAt.getTime();
    return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Keyset paging with Postgres's semantics: a cursor is a post id in the same
 * tenant, the page starts strictly after it, and a cursor that names no such
 * post (missing, or another tenant's) starts the list over.
 */
function page(
    rows: AudioPostRecord[],
    originAppId: string,
    direction: 'asc' | 'desc',
    limit: number,
    cursorId: string | undefined,
    all: Map<string, AudioPostRecord>,
): AudioPostRecord[] {
    const sorted = [...rows].sort((a, b) => (direction === 'asc' ? compare(a, b) : compare(b, a)));
    const cursor = cursorId ? all.get(cursorId) : undefined;
    const from = cursor && cursor.originAppId === originAppId
        ? sorted.filter((r) => (direction === 'asc' ? compare(r, cursor) > 0 : compare(r, cursor) < 0))
        : sorted;
    return from.slice(0, limit);
}

export function inMemoryAudioPostDependencies(
    overrides: Partial<AudioPostDependencies> = {},
): InMemoryAudioPostDependencies {
    const posts = new Map<string, AudioPostRecord>();
    const spaces = new Set<string>();
    const blobs = new Map<string, SpaceKey | null>();
    const transcripts = new Map<string, TranscriptEnrichmentRecord>();
    let counter = 0;
    const clone = (r: AudioPostRecord): AudioPostRecord => structuredClone(r);
    const inTenant = (originAppId: string) => [...posts.values()].filter((p) => p.originAppId === originAppId);

    const deps: InMemoryAudioPostDependencies = {
        posts,
        spaces,
        blobs,
        transcripts,
        newPostId: () => `3kpost${++counter}aaaaa`,
        getAppDid: (originAppId) => `did:web:${originAppId}.example`,
        now: () => new Date(),
        cidForRecord: async () => `bafyreitestcid${counter}`,
        resolveAudioUrl: async (originAppId, blobCid) => `https://audio.example/${originAppId}/${blobCid}`,

        async savePost(record) {
            const existing = posts.get(record.id);
            if (existing && existing.originAppId !== record.originAppId) {
                throw new Error(`failed to save post "${record.id}": the id belongs to another tenant`);
            }
            const next = clone(record);
            // Like the Postgres upsert: a save without processing state keeps
            // what the processing worker stored.
            if (next.processing === undefined && existing?.processing !== undefined) {
                next.processing = existing.processing;
            }
            posts.set(record.id, next);
        },

        async patchProcessingState(originAppId, postId, patch) {
            const existing = posts.get(postId);
            if (!existing || existing.originAppId !== originAppId) {
                throw new Error(`failed to patch processing state: post "${postId}" not found in origin "${originAppId}"`);
            }
            const merged: Record<string, unknown> = { ...existing.processing };
            for (const [key, value] of Object.entries(patch)) {
                if (value !== undefined) merged[key] = value;
            }
            merged.updatedAt = deps.now();
            posts.set(postId, { ...existing, processing: merged as AudioPostRecord['processing'] });
        },

        async getPostById(originAppId, id) {
            if (!id?.trim()) return null;
            const found = posts.get(id);
            return found && found.originAppId === originAppId ? clone(found) : null;
        },

        async queryByAuthor(originAppId, authorId, options: AudioPostQueryOptions = {}) {
            const { kind, limit = 20, cursorId } = options;
            const rows = inTenant(originAppId).filter((p) => p.authorId === authorId && (!kind || p.kind === kind));
            return page(rows, originAppId, 'desc', limit, cursorId, posts).map(clone);
        },

        async queryByRootAuthor(originAppId, rootAuthorId, options: AudioPostQueryOptions = {}) {
            const { limit = 20, cursorId } = options;
            const rows = inTenant(originAppId).filter((p) => p.kind === 'reply' && p.rootAuthorId === rootAuthorId);
            return page(rows, originAppId, 'desc', limit, cursorId, posts).map(clone);
        },

        async queryReplies(originAppId, parentUri, options: AudioPostThreadOptions = {}) {
            const { limit = 50, cursorId } = options;
            const rows = inTenant(originAppId).filter((p) => p.kind === 'reply' && p.reply?.parent.uri === parentUri);
            return page(rows, originAppId, 'asc', limit, cursorId, posts).map(clone);
        },

        async getTranscriptsBySubjectUris(uris) {
            const map = new Map<string, TranscriptEnrichmentRecord>();
            for (const uri of uris) {
                const t = transcripts.get(uri);
                if (t) map.set(uri, t);
            }
            return map;
        },

        async getSpace(originAppId, key): Promise<SpaceRecord | null> {
            if (!spaces.has(spaceKeyOf(originAppId, key))) return null;
            const at = new Date('2026-10-07T00:00:00Z');
            return { originAppId, ...key, readPolicy: 'managing-app', writePolicy: 'managing-app', createdAt: at, updatedAt: at };
        },

        async getBlobSpace(originAppId, blobCid) {
            const key = `${originAppId}/${blobCid}`;
            return blobs.has(key) ? { space: blobs.get(key) ?? null } : null;
        },

        ...overrides,
    };
    return deps;
}
