import type { RemoteSpace } from 'shared/types/remote-posts';
import type { FetchedBlob, FetchedRecord, RepoRecordRef, RepoResult } from './public-repo';

/**
 * SpaceRepoPort — reading a record and its blob from a permissioned space,
 * on a member's delegation (specs/audio-service-mode.md §4.2, Phase C).
 *
 * `open` makes one credential exchange at the space authority's host
 * (`com.atproto.space.getSpaceCredential`), spending the delegation token,
 * for a credential bound to a key the adapter generates and never shares. The
 * reader it returns presents that credential to each writer's own PDS,
 * signed for that writer, and checks the record MAC `getRecord` answers with.
 * A credential lives about ten minutes, so a reader is for one call's work.
 *
 * Failures are classified as for public repos (`RepoFailureKind`), plus two
 * the exchange can answer:
 *  - `refused`: the authority won't issue a credential for this delegation.
 *    A host answers a refusal and a missing space alike (`SpaceNotFound`), so
 *    this never means the space is gone.
 *  - `deleted`: the authority says the space was deleted (`SpaceDeleted`).
 */

export interface SpaceDelegation {
    /** From a member's PDS, `com.atproto.space.getDelegationToken`. Single use. */
    delegationToken: string;
    /** From the tenant's OAuth client, for a space that only admits listed apps. */
    clientAttestation?: string;
}

/** Reads within one space, with one credential. */
export interface SpaceReader {
    /** The record from its writer's PDS (`ref.did` is the writer), its MAC verified. */
    getRecord(ref: RepoRecordRef): Promise<RepoResult<FetchedRecord>>;
    /** Read at most `maxBytes`; a larger blob is `invalid`. */
    getBlob(repoDid: string, cid: string, maxBytes: number): Promise<RepoResult<FetchedBlob>>;
    /** When the credential expires (ms since epoch). */
    expiresAt: number;
}

export type SpaceOpenResult =
    | { ok: true; reader: SpaceReader }
    | { ok: false; kind: 'refused' | 'deleted' | 'unreachable' | 'invalid'; reason: string };

export interface SpaceRepoPort {
    open(space: RemoteSpace, delegation: SpaceDelegation): Promise<SpaceOpenResult>;
}
