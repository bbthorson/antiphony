import type { AudioPostRecord, TranscriptEnrichmentRecord } from 'shared/types/audio';

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
    /**
     * Generate a new unique post id without creating the document. The id is the
     * `rkey` in the post's `at://{appDid}/{collection}/{rkey}` uri, so the binding
     * mints an AT-Proto record key (a time-sortable TID) — needing a clock +
     * randomness is exactly why id generation lives here on the port, not in core.
     */
    newPostId(): string;

    /**
     * Resolve a tenant (`originAppId`) to the **app DID** that is the `at://`
     * authority for every record it writes (`at://{appDid}/{collection}/{rkey}`).
     * Fail-closed: throws for an unpinned or unvalidated tenant, since a post
     * uri cannot be well-formed without a proven DID authority. Backed by the
     * boot-validated pin snapshot in the adapter — core never reads config.
     */
    getAppDid(originAppId: string): string;

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
     * List replies whose thread ROOT was authored by `rootAuthorId`, within an
     * origin app, newest first, cursor-paginated. `rootAuthorId` is stamped only
     * on replies, so this query is inherently reply-only (no `kind` filter). The
     * "replies to author X" primitive; a caller BFF composes it into an inbox.
     */
    queryByRootAuthor(
        originAppId: string,
        rootAuthorId: string,
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
     * Resolve a stored audio blob CID (`BlobRef.ref.$link`) to a short-lived,
     * playable signed URL, scoped to the owning origin app (the blob lives at
     * a tenancy-scoped path derived from the CID). Returns null when the CID
     * can't be resolved to a storage object.
     */
    signAudioUrl(originAppId: string, blobCid: string): Promise<string | null>;

    /**
     * Compute the content CID for a canonical lexicon record — DAG-CBOR
     * encoding, CIDv1, sha2-256 (the AT Protocol record-CID rule). Lives on
     * the dependency port so `@antiphony/core` stays free of codec/runtime
     * deps; the binding implements it with `multiformats` + `@ipld/dag-cbor`.
     */
    cidForRecord(canonicalRecord: Record<string, unknown>): Promise<string>;

    /** Current server time as a `Date`. */
    now(): Date;
}
