import type { AudioPostRecord } from 'shared/types/audio';
import type { AudioPostDependencies } from './audio-posts-dependencies';

/**
 * What `PostDeletionService` needs from the store (specs/deletion.md). The
 * Postgres binding lives in
 * `apps/core-api/src/adapters/outbound/postgres/post-deletion-dependencies.ts`.
 *
 * **Tenancy:** every call takes `originAppId`, as on `AudioPostDependencies`.
 * Blobs are stored per tenant, so "another record still references this blob"
 * only ever means a post in the same tenant.
 */

/** A post to delete, with the URI its ledger row keeps. */
export interface PostToDelete {
    id: string;
    uri: string;
    kind: 'prompt' | 'reply';
}

/** A deletion ledger row. Content-free by design: no text, CID, author or actor. */
export interface DeletedPostRecord {
    postId: string;
    uri: string;
    kind: 'prompt' | 'reply';
    deletedAt: Date;
}

/** What one drain of the blob-deletion queue did. */
export interface BlobDrainResult {
    /** CIDs whose objects (blob and renditions) were deleted. */
    deleted: number;
    /** CIDs dropped from the queue because a remaining post still references them. */
    retained: number;
}

export interface PostDeletionDependencies
    extends Pick<AudioPostDependencies, 'getAppDid' | 'getPostById' | 'queryByAuthor'> {
    /** The ledger row for a deleted post, or null when the tenant never deleted that id. */
    getDeletedPost(originAppId: string, postId: string): Promise<DeletedPostRecord | null>;

    /**
     * Every reply in a thread: the posts whose `reply.root.uri` is `rootUri`.
     * Unpaged, because finding a subtree needs the whole thread; a delete reads
     * one thread at a time.
     */
    listThreadReplies(originAppId: string, rootUri: string): Promise<AudioPostRecord[]>;

    /**
     * Delete posts, atomically with everything that has to move with them:
     * their rows, their transcripts, their ledger rows, and a queue entry for
     * every blob CID they referenced (original, processed, every derived
     * variant). Returns the ids actually removed; an id already gone (a
     * concurrent delete) is simply absent from the result.
     *
     * Does NOT touch blob storage: that is `drainBlobDeletions`, so a crash
     * between the two leaves the queue saying what is still to do.
     */
    deletePosts(originAppId: string, posts: PostToDelete[]): Promise<string[]>;

    /**
     * Work through queued blob CIDs, oldest first, up to `limit`. For each, if
     * no remaining post in its tenant references it, delete the blob and its
     * renditions; either way, remove it from the queue. `originAppId` null
     * drains every tenant (the cron). Safe to run concurrently and repeatedly:
     * deleting a missing object succeeds.
     */
    drainBlobDeletions(originAppId: string | null, limit: number): Promise<BlobDrainResult>;
}
