/**
 * PublicRepoPort — reading a public record and its blob from the repo that
 * holds them (specs/audio-service-mode.md §4.1). The adapter resolves the DID
 * to its `#atproto_pds` and calls `com.atproto.repo.getRecord` and
 * `com.atproto.sync.getBlob` there; nothing here names a transport.
 *
 * Every failure is classified the way the pin validator classifies a DID
 * document, because the deletion sweep acts on the difference:
 *  - `gone`: the repo answered that the record (or blob, or account) doesn't
 *    exist. Repeated, it deletes Antiphony's copy.
 *  - `unreachable`: no usable answer (timeout, 5xx, network, a body that
 *    isn't what was asked for). Never deletes anything.
 *  - `invalid`: an answer that can't be accepted (too large, wrong shape).
 */
export type RepoFailureKind = 'gone' | 'unreachable' | 'invalid';

export type RepoResult<T> = { ok: true; value: T } | { ok: false; kind: RepoFailureKind; reason: string };

/** A plain record address in a repo: `at://{did}/{collection}/{rkey}`. */
export interface RepoRecordRef {
    did: string;
    collection: string;
    rkey: string;
}

export interface FetchedRecord {
    /** The CID the repo reported. The service recomputes it and compares. */
    cid: string;
    /** The record value, in atproto's JSON form (`$link`, `$bytes`). */
    value: unknown;
}

export interface FetchedBlob {
    bytes: Uint8Array;
    /** The Content-Type the repo sent, if any. Not trusted for playback. */
    contentType?: string;
}

export interface PublicRepoPort {
    getRecord(ref: RepoRecordRef): Promise<RepoResult<FetchedRecord>>;
    /** Read at most `maxBytes`; a larger blob is `invalid`. */
    getBlob(did: string, cid: string, maxBytes: number): Promise<RepoResult<FetchedBlob>>;
}
