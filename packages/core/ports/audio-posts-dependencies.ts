import type { AudioPostRecord, TranscriptEnrichmentRecord } from 'shared/types/audio';
import type { ProfileViewBasic } from 'shared/types/views';

/**
 * AudioPostDependencies is the portable interface the `AudioPostService`
 * (Antiphony `dev.antiphony.audio.post` model) uses to reach the data store
 * and the audio blob store. Lives in `packages/core/` alongside the service;
 * the Firestore-backed binding lives in
 * `apps/core-api/src/adapters/outbound/firebase/audio-posts-dependencies.ts`.
 *
 * **Tenancy:** every read takes `originAppId` — the multi-tenant isolation
 * key. The binding scopes all queries by it so one origin app can never read
 * another's posts.
 */

export interface AudioPostQueryOptions {
    /** Restrict to one kind (denormalized index field). */
    kind?: 'prompt' | 'reply';
    /** Page size. Default 20. */
    limit?: number;
    /** Cursor — post id to start after (exclusive). */
    cursorId?: string;
}

export interface AudioPostThreadOptions {
    /** Page size. Default 50. */
    limit?: number;
    /** Cursor — post id to start after (exclusive). */
    cursorId?: string;
}

export interface AudioPostDependencies {
    /** Generate a new unique post id without creating the document. */
    newPostId(): string;

    /** Persist a canonical post record (upsert). */
    savePost(record: AudioPostRecord): Promise<void>;

    /**
     * Fetch a single post by id, scoped to `originAppId`. Returns null when the
     * post is missing OR belongs to a different origin app (tenancy isolation).
     */
    getPostById(originAppId: string, id: string): Promise<AudioPostRecord | null>;

    /** List an author's posts within an origin app, newest first, cursor-paginated. */
    queryByAuthor(
        originAppId: string,
        authorId: string,
        options?: AudioPostQueryOptions,
    ): Promise<AudioPostRecord[]>;

    /**
     * List replies whose `reply.parent.uri` matches `parentUri`, within an
     * origin app, oldest first (thread reading order), cursor-paginated.
     */
    queryReplies(
        originAppId: string,
        parentUri: string,
        options?: AudioPostThreadOptions,
    ): Promise<AudioPostRecord[]>;

    /**
     * Batch-fetch transcript enrichment records by their subject post uris.
     * Returned Map is keyed by `subject.uri`; posts without a transcript are
     * simply absent. The platform-enrichment lift (transcript → embed view)
     * reads from here — never from the canonical record.
     */
    getTranscriptsBySubjectUris(uris: string[]): Promise<Map<string, TranscriptEnrichmentRecord>>;

    /**
     * Batch-fetch author profiles (already projected to the public basic shape)
     * keyed by user id. Missing authors are absent from the Map.
     */
    getAuthorsByIds(ids: string[]): Promise<Map<string, ProfileViewBasic>>;

    /**
     * Resolve a stored canonical audio URL (a `BlobRef.ref`) to a short-lived,
     * playable signed URL. Returns null when the URL can't be resolved to a
     * storage object.
     */
    signAudioUrl(canonicalUrl: string): Promise<string | null>;

    /** Current server time as a `Date`. */
    now(): Date;
}
