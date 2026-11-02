import type { TranscriptEnrichmentRecord } from 'shared/types/audio';
import type { ProcessingState, ResolvedProcessing } from 'shared/types/processing';
import type { RemoteAudioPostRecord, RemoteSpace } from 'shared/types/remote-posts';
import type { ScopedSpaceKey } from 'shared/types/spaces';

/**
 * A registered remote post as stored (`remote_posts`, migrations 0006, 0008). The
 * record lives in another repo; this is Antiphony's index of it, its copy of
 * the blob, and the processing state of that copy.
 */
export interface RemotePostRow {
    originAppId: string;
    uri: string;
    cid: string;
    /** The DID whose repo holds the record: the URI's authority, or a space record's author segment. */
    repoDid: string;
    collection: string;
    rkey: string;
    /** The space the record is in; null for a plain repo record. */
    space: RemoteSpace | null;
    /** `fetched`: read from the source by Antiphony. `pushed`: sent by the tenant (Phase B). */
    verified: 'fetched' | 'pushed';
    record: RemoteAudioPostRecord;
    blob: { cid: string; mimeType: string; size: number };
    /** The post plays from signed URLs only: always for a space record (see migration 0006). */
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

    /**
     * The rows least recently checked, for the deletion sweep. Only rows
     * Antiphony can read (`verified: 'fetched'`): a pushed space record's only
     * deletion signal is the tenant's DELETE (§8.1).
     */
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
     * Whether the tenant already stores these bytes, and the space they are
     * marked private for (null ⇒ public). A stored blob is never re-downloaded.
     */
    getStoredBlob(originAppId: string, cid: string): Promise<{ space: ScopedSpaceKey | null } | null>;

    /**
     * Store downloaded bytes under their CID, public. If an object with that
     * CID appeared meanwhile it is kept as it is, and its marking returned.
     */
    storeBlob(
        originAppId: string,
        cid: string,
        bytes: Uint8Array,
        mimeType: string,
    ): Promise<{ space: ScopedSpaceKey | null }>;

    /**
     * Whether a **verified** public record of this tenant references the blob
     * as its audio: a hosted flat post, or a remote post Antiphony fetched
     * from a public repo (§7). Pushed records never count.
     */
    hasVerifiedPublicReference(originAppId: string, blobCid: string): Promise<boolean>;

    /**
     * Turn a private blob public (§7): rewrite the marking off the original
     * and off every derived variant any of the tenant's posts made from it
     * (`processedBlobCid`, `derivedBlobCids`), in one step. Paths and CIDs
     * don't change. Idempotent; never the other way.
     */
    makeBlobPublic(originAppId: string, blobCid: string): Promise<void>;

    /** The CID of raw bytes (CIDv1, raw, sha2-256), as atproto blob refs use. */
    cidForBytes(bytes: Uint8Array): Promise<string>;

    /** The CID of a record in atproto's JSON form (`$link` as a CID link). */
    cidForRepoRecord(value: unknown): Promise<string>;

    /** A playback URL: stable for a public blob, signed for a private one (null if it can't sign). */
    resolveAudioUrl(originAppId: string, blobCid: string, isPrivate: boolean): Promise<string | null>;

    now(): Date;
}
