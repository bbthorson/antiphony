import type { TranscriptEnrichmentRecord } from 'shared/types/audio';
import type { ProcessingState, ResolvedProcessing } from 'shared/types/processing';
import type { RemoteAudioPostRecord } from 'shared/types/remote-posts';

/**
 * A registered remote post as stored (`remote_posts`, migration 0006). The
 * record lives in another repo; this is Antiphony's index of it, its copy of
 * the blob, and the processing state of that copy.
 */
export interface RemotePostRow {
    originAppId: string;
    uri: string;
    cid: string;
    repoDid: string;
    collection: string;
    rkey: string;
    record: RemoteAudioPostRecord;
    blob: { cid: string; mimeType: string; size: number };
    /** The stored blob plays from signed URLs only (see the migration). */
    blobPrivate: boolean;
    processing?: ProcessingState;
    createdAt: Date;
    registeredAt: Date;
    checkedAt: Date;
    goneAt: Date | null;
    unreachableSince: Date | null;
}

/** What `saveRemotePost` writes; the bookkeeping columns default. */
export type RemotePostWrite = Omit<RemotePostRow, 'registeredAt' | 'checkedAt' | 'goneAt' | 'unreachableSince'>;

/** One row due for a sweep recheck. */
export interface RemoteSweepRow {
    originAppId: string;
    uri: string;
    cid: string;
    goneAt: Date | null;
    unreachableSince: Date | null;
}

/** The outcome of one recheck, recorded on the row. */
export type RemoteCheckOutcome = 'present' | 'gone' | 'unreachable';

export interface RemotePostDependencies {
    getRemotePost(originAppId: string, uri: string): Promise<RemotePostRow | null>;

    /**
     * Insert or replace the row for `(originAppId, uri)`. Clears any ledger
     * entry for it (a re-registration of a record that still exists), and
     * resets the sweep's bookkeeping: the record was just read.
     */
    saveRemotePost(row: RemotePostWrite): Promise<void>;

    /** When this tenant's registration of `uri` was removed, if it was. */
    getDeletedRemotePost(originAppId: string, uri: string): Promise<{ deletedAt: Date; reason: 'tenant' | 'gone' } | null>;

    /**
     * Remove a registration in one statement: the row, its transcript, a
     * ledger entry, and its blob and variants queued for the drain (which
     * keeps any another post still references). False if there was none.
     */
    deleteRemotePost(originAppId: string, uri: string, reason: 'tenant' | 'gone'): Promise<boolean>;

    /** Registered replies whose `reply.root` is `rootUri`, oldest first, paged by URI. */
    listThread(
        originAppId: string,
        rootUri: string,
        page: { limit: number; cursor?: string },
    ): Promise<{ items: RemotePostRow[]; nextCursor: string | null }>;

    /** Merge requested stages onto the stored state (stamps `updatedAt`). */
    mergeProcessing(originAppId: string, uri: string, resolved: ResolvedProcessing): Promise<void>;

    /** The rows least recently checked, for the deletion sweep. */
    listForSweep(limit: number): Promise<RemoteSweepRow[]>;

    /**
     * Record a recheck. `present` clears `goneAt` and `unreachableSince`;
     * `gone` sets `goneAt` if unset and clears `unreachableSince`;
     * `unreachable` sets `unreachableSince` if unset and clears `goneAt` (two
     * "gone" reads must be consecutive). Always stamps `checkedAt`.
     */
    recordCheck(originAppId: string, uri: string, outcome: RemoteCheckOutcome): Promise<void>;

    getTranscripts(originAppId: string, uris: string[]): Promise<Map<string, TranscriptEnrichmentRecord>>;

    /**
     * Whether the tenant already stores these bytes, and whether privately.
     * A stored blob is never re-downloaded or re-marked (§7, Phase B).
     */
    getStoredBlob(originAppId: string, cid: string): Promise<{ private: boolean } | null>;

    /**
     * Store downloaded bytes under their CID, public. If an object with that
     * CID appeared meanwhile it is kept as it is, and its visibility returned.
     */
    storeBlob(originAppId: string, cid: string, bytes: Uint8Array, mimeType: string): Promise<{ private: boolean }>;

    /** The CID of raw bytes (CIDv1, raw, sha2-256), as atproto blob refs use. */
    cidForBytes(bytes: Uint8Array): Promise<string>;

    /** The CID of a record in atproto's JSON form (`$link` as a CID link). */
    cidForRepoRecord(value: unknown): Promise<string>;

    /** A playback URL: stable for a public blob, signed for a private one (null if it can't sign). */
    resolveAudioUrl(originAppId: string, blobCid: string, isPrivate: boolean): Promise<string | null>;

    now(): Date;
}
