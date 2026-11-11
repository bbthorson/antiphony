import { isValidDid, isValidNsid, isValidRecordKey } from '@atproto/syntax';
import { ServiceError } from 'shared/errors';
import type { TranscriptEnrichmentRecord } from 'shared/types/audio';
import {
    PROCESSING_STAGES,
    resolveAudioVariant,
    toProcessingView,
    type ProcessingState,
    type ResolvedProcessing,
} from 'shared/types/processing';
import {
    RemoteAudioPostRecordSchema,
    type RemoteAudioPostRecord,
    type RemotePostView,
    type RemoteSpace,
} from 'shared/types/remote-posts';
import type { ScopedSpaceKey } from 'shared/types/spaces';
import type { PublicRepoPort, RepoFailureKind, RepoRecordRef } from '../ports/public-repo';
import type { SpaceDelegation, SpaceOpenResult, SpaceRepoPort } from '../ports/space-repo';
import type {
    RemotePostDependencies,
    RemoteListPosition,
    RemotePostFilter,
    RemotePostRow,
    RemotePostWrite,
    RemoteSweepRow,
} from '../ports/remote-posts-dependencies';
import { type RemoteNotifierPort, noopRemoteNotifier } from '../ports/remote-notifier';
import { type Logger, defaultLogger } from '../ports/logger';

/** The only collection a remote post may be in. */
export const AUDIO_POST_COLLECTION = 'dev.antiphony.audio.post';

/** The largest blob Antiphony copies: the same cap as an upload. */
export const MAX_REMOTE_BLOB_BYTES = 25 * 1024 * 1024;

/** How long a "gone" read must stand before the sweep removes a post (§8.1). */
export const REMOTE_GONE_CONFIRM_MS = 60 * 60 * 1000;

/** How long a repo may stay unreachable before its post stops being served (§8.1). */
export const REMOTE_UNAVAILABLE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long after its last check a space row is asked about again: the sweep
 * sends `remote.recheck_requested` for a space whose oldest check is older
 * than this (§8.1, Phase C).
 */
export const REMOTE_RECHECK_REQUEST_AFTER_MS = 60 * 60 * 1000;

/**
 * How long after its last check a space row is due in a recheck call. A
 * credential lives ten minutes, so this is its life: the pages of one burst of
 * calls never read the same row twice.
 */
export const REMOTE_RECHECK_DUE_AFTER_MS = 10 * 60 * 1000;

/** The most rows one recheck call reads; the rest are `remaining`. */
export const MAX_RECHECK_ROWS = 100;

/** Stop a recheck this long before the credential expires, rather than race it. */
const CREDENTIAL_MARGIN_MS = 60 * 1000;

/**
 * 400: the URI isn't an audio post record Antiphony can register, or it names a
 * space record to be fetched (Antiphony can't read a space before Phase C).
 */
export const REMOTE_URI_UNSUPPORTED = 'REMOTE_URI_UNSUPPORTED';
/**
 * 400: the request's fields don't fit its URI: `record` or `delegationToken`
 * for a repo record, neither for a space record, or both at once.
 */
export const REMOTE_REQUEST_INVALID = 'REMOTE_REQUEST_INVALID';
/**
 * 403: the space's authority wouldn't issue a credential for this delegation.
 * Its member may not read the space, the token was spent or expired, or the
 * space doesn't exist: a host answers all of these alike, so this never means
 * the space is gone.
 */
export const REMOTE_DELEGATION_REFUSED = 'REMOTE_DELEGATION_REFUSED';
/** 404: the repo says the record doesn't exist. */
export const REMOTE_RECORD_NOT_FOUND = 'REMOTE_RECORD_NOT_FOUND';
/** 503: the record's repo couldn't be read right now. */
export const REMOTE_REPO_UNREACHABLE = 'REMOTE_REPO_UNREACHABLE';
/** 409: the record's current CID isn't the one registered; it changed since the tenant read it. */
export const REMOTE_CID_MISMATCH = 'REMOTE_CID_MISMATCH';
/** 422: the record isn't an audio post Antiphony can accept, or its blob doesn't check out. */
export const REMOTE_RECORD_INVALID = 'REMOTE_RECORD_INVALID';
/**
 * 409: a pushed space record's audio isn't stored private for that space: it
 * was uploaded for another space, or uploaded public and no verified public
 * record references it (§7).
 */
export const REMOTE_BLOB_SPACE_MISMATCH = 'REMOTE_BLOB_SPACE_MISMATCH';
/** 404: this tenant hasn't registered the URI. */
export const REMOTE_POST_NOT_FOUND = 'REMOTE_POST_NOT_FOUND';
/** 410: this tenant's registration was removed (by the tenant, or because the record is gone). */
export const REMOTE_POST_DELETED = 'REMOTE_POST_DELETED';

/** The most replies one thread page returns. */
export const MAX_REMOTE_THREAD_PAGE = 100;

/** Page cap for `RemotePostService.list`, as `com.atproto.repo.listRecords` has. */
export const MAX_REMOTE_LIST_PAGE = 100;

/** A list cursor this service didn't issue (XRPC `InvalidCursor`). */
export const INVALID_CURSOR = 'INVALID_CURSOR';

/**
 * A list cursor: the last row's `createdAt` and URI, `{ISO datetime}::{uri}`.
 * Opaque to callers. It names a position rather than a row, so a page still
 * follows on when the row it ended at has since been removed.
 */
export function encodeRemoteListCursor(position: RemoteListPosition): string {
    return `${position.createdAt.toISOString()}::${position.uri}`;
}

export function decodeRemoteListCursor(cursor: string): RemoteListPosition {
    const at = cursor.indexOf('::');
    const createdAt = at > 0 ? new Date(cursor.slice(0, at)) : new Date(NaN);
    const uri = at > 0 ? cursor.slice(at + 2) : '';
    if (Number.isNaN(createdAt.getTime()) || !uri.startsWith('at://')) {
        throw new ServiceError('Invalid cursor: pass the `cursor` of the previous page unchanged', 400, undefined, INVALID_CURSOR);
    }
    return { createdAt, uri };
}

/**
 * A parsed remote post URI. `did` is the DID whose repo holds the record: the
 * authority of a repo record, the author segment of a space record.
 */
export interface RemoteUriRef extends RepoRecordRef {
    space: RemoteSpace | null;
}

/**
 * Parse a remote post's URI, either
 *  - a repo record, `at://{did}/dev.antiphony.audio.post/{rkey}`, or
 *  - a space record, `at://{authority}/space/{type}/{skey}/{authorDid}/dev.antiphony.audio.post/{rkey}`.
 */
export function parseRemotePostUri(uri: string): RemoteUriRef {
    const unsupported = (why: string) =>
        new ServiceError(`${why}: ${uri}`, 400, undefined, REMOTE_URI_UNSUPPORTED);
    const repo = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
    const spaced = /^at:\/\/([^/]+)\/space\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
    let space: RemoteSpace | null = null;
    let did: string, collection: string, rkey: string;
    if (repo) {
        [, did, collection, rkey] = repo;
    } else if (spaced) {
        space = checkSpace(spaced[1], spaced[2], spaced[3], unsupported);
        [, , , , did, collection, rkey] = spaced;
        if (!isValidDid(did)) throw unsupported("A space record's author segment must be a DID");
    } else {
        throw unsupported(
            'Expected at://{did}/dev.antiphony.audio.post/{rkey} or ' +
                'at://{authority}/space/{type}/{skey}/{authorDid}/dev.antiphony.audio.post/{rkey}',
        );
    }
    if (!isValidDid(did)) throw unsupported('The URI authority must be a DID');
    if (!isValidNsid(collection) || collection !== AUDIO_POST_COLLECTION) {
        throw unsupported(`Only ${AUDIO_POST_COLLECTION} records can be registered`);
    }
    if (!isValidRecordKey(rkey)) throw unsupported('Invalid record key');
    return { did, collection, rkey, space };
}

/**
 * Parse a space held outside Antiphony, `at://{authority}/space/{type}/{skey}`,
 * as `POST /api/v1/audio/upload` takes it in `remoteSpace` (Phase B). Throws a
 * 400 `ServiceError` for anything else.
 */
export function parseRemoteSpaceUri(uri: string): RemoteSpace {
    const unsupported = (why: string) => new ServiceError(`${why}: ${uri}`, 400, undefined, REMOTE_URI_UNSUPPORTED);
    const match = /^at:\/\/([^/]+)\/space\/([^/]+)\/([^/]+)$/.exec(uri);
    if (!match) throw unsupported('Expected at://{authority}/space/{type}/{skey}');
    return checkSpace(match[1], match[2], match[3], unsupported);
}

function checkSpace(authority: string, type: string, skey: string, fail: (why: string) => ServiceError): RemoteSpace {
    if (!isValidDid(authority)) throw fail("The space's authority must be a DID");
    if (!isValidNsid(type)) throw fail('The space type must be an NSID');
    if (!isValidRecordKey(skey)) throw fail('Invalid space key');
    return { authority, type, skey };
}

/** Whether a blob's marking names exactly this remote space. */
function markedFor(marking: ScopedSpaceKey, space: RemoteSpace): boolean {
    return marking.authority === space.authority && marking.type === space.type && marking.skey === space.skey;
}

/**
 * The audio type of `bytes`, from their leading bytes, or null if they aren't
 * audio Antiphony serves. The record's `mimeType` is the writer's claim and
 * is never what playback trusts (hatk `blob.ts` does the same for images).
 */
export function sniffAudioMime(bytes: Uint8Array): string | null {
    const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
    if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') return 'audio/mp4';
    if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
        return 'audio/webm';
    }
    if (bytes.length >= 4 && ascii(0, 4) === 'OggS') return 'audio/ogg';
    if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
    if (bytes.length >= 3 && ascii(0, 3) === 'ID3') return 'audio/mpeg';
    if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
    return null;
}

/** Whether any stage is waiting to run, so the caller should dispatch. */
export function hasPendingStage(processing: ProcessingState | undefined): boolean {
    return !!processing && PROCESSING_STAGES.some((s) => processing[s] === 'pending');
}

/**
 * A read that came back usable, ready to store. `publish`: the read verified a
 * public record whose bytes are stored private here, so they turn public
 * before the row is saved (§7).
 */
type SourceRead =
    | { ok: true; write: RemotePostWrite; publish: boolean }
    | { ok: false; kind: RepoFailureKind | 'mismatch'; reason: string };

export interface RegisterInput {
    uri: string;
    cid: string;
    /** Requested stages, already resolved against the deployment's capabilities. */
    processing?: ResolvedProcessing;
    /** Where the bytes come from; defaults to `fetch` for a repo record and `upload` for a space record. */
    bytesFrom?: 'fetch' | 'upload';
    /** The record body, for a space record the tenant pushes (Phase B); refused for a repo record. */
    record?: Record<string, unknown>;
    /** A member's delegation, for a space record Antiphony reads itself (Phase C). */
    delegationToken?: string;
    /** For a space that only admits listed apps; sent with `delegationToken`. */
    clientAttestation?: string;
}

export interface RegisterResult {
    row: RemotePostRow;
    /** `created`: first registration. `updated`: the record changed since. `unchanged`: a repeat. */
    outcome: 'created' | 'updated' | 'unchanged';
    /** Whether a stage is pending, so the caller dispatches processing. */
    dispatch: boolean;
}

export interface SweepResult {
    checked: number;
    removed: number;
    changed: number;
    /** Rows whose processing must be dispatched after an edit. */
    toDispatch: { originAppId: string; uri: string }[];
    /** Spaces the tenant was asked to recheck (`remote.recheck_requested`). */
    rechecksRequested: number;
}

export interface RecheckResult extends Omit<SweepResult, 'rechecksRequested'> {
    space: string;
    /** Whether rows in the space are still due: call again with a fresh delegation. */
    remaining: boolean;
}

/** Where a record and its blob are read from: a public repo, or a space on a credential. */
type RecordSource = Pick<PublicRepoPort, 'getRecord' | 'getBlob'>;

/** Space reads, before any are configured: every exchange is unreachable. */
const noSpaces: SpaceRepoPort = {
    async open() {
        return { ok: false, kind: 'unreachable', reason: 'space reads are not configured here' };
    },
};

/**
 * RemotePostService — audio whose record lives in a repo Antiphony doesn't
 * host (specs/audio-service-mode.md).
 *
 * A tenant registers a record by URI and CID.
 *  - **A repo record** (Phase A) is read from the repo the URI names, never
 *    from a body the tenant sends. The service recomputes its CID, checks its
 *    shape, copies its blob after checking the bytes hash to the blob ref, and
 *    indexes it. A sweep rechecks the source and removes Antiphony's copy once
 *    the record is gone (§8).
 *  - **A space record, on a delegation** (Phase C). The tenant passes a
 *    member's delegation token, and Antiphony exchanges it at the space's
 *    authority for a credential bound to its own key. It then reads the record
 *    and its blob from the writer's PDS, checked as for a repo record. That
 *    proves a member authorized the read. A credential lasts ten minutes, so
 *    the sweep asks the tenant for a fresh delegation to recheck each space
 *    (`remote.recheck_requested`, answered with `recheckSpace`).
 *  - **A space record, pushed** (Phase B). The tenant pushes the record body,
 *    which must hash to the CID, and bytes it uploaded with `remoteSpace`
 *    naming the same space. That proves content, not access, and tenant
 *    scoping is what contains a made-up one (open question 3). Until a
 *    recheck reads it, the tenant's DELETE is its only deletion signal.
 *
 * Processing, transcripts and playback then work as for a hosted post. A blob
 * is private while only space records reference it, and turns public, for
 * good, once a verified public record does (§7).
 */
export class RemotePostService {
    constructor(
        private readonly deps: RemotePostDependencies,
        private readonly repo: PublicRepoPort,
        private readonly notifier: RemoteNotifierPort = noopRemoteNotifier,
        private readonly logger: Logger = defaultLogger,
        private readonly spaces: SpaceRepoPort = noSpaces,
    ) {}

    async register(originAppId: string, input: RegisterInput): Promise<RegisterResult> {
        const ref = parseRemotePostUri(input.uri);
        const delegation = delegationOf(input);
        const invalid = (message: string) => new ServiceError(message, 400, undefined, REMOTE_REQUEST_INVALID);
        if (input.clientAttestation && !delegation) throw invalid('`clientAttestation` is sent with a `delegationToken`');
        if (!ref.space) {
            if (input.record) throw invalid("A repo record is read from its repo; don't send `record`");
            if (delegation) throw invalid("A repo record is public; a `delegationToken` is for a space record");
        } else if (delegation && input.record) {
            throw invalid('Send `delegationToken` for Antiphony to read the record, or `record` to push it, not both');
        }
        const bytesFrom = input.bytesFrom ?? (ref.space && !delegation ? 'upload' : 'fetch');
        if (ref.space && !delegation) {
            if (bytesFrom === 'fetch') {
                throw new ServiceError(
                    `Antiphony reads a space record on a member's delegation: send \`delegationToken\`, or push it with \`record\` and \`bytesFrom: "upload"\`: ${input.uri}`,
                    400,
                    undefined,
                    REMOTE_URI_UNSUPPORTED,
                );
            }
            if (!input.record) {
                throw invalid('A space record is registered with a `delegationToken`, or pushed with its `record` body');
            }
        }
        const existing = await this.deps.getRemotePost(originAppId, input.uri);

        // A repeat of what's registered: nothing to fetch. A processing request
        // still applies, as it would through PATCH. A delegation for a row that
        // was only pushed is not a repeat: it's a chance to read it.
        if (existing && existing.cid === input.cid && !(delegation && existing.verified === 'pushed')) {
            if (!input.processing) return { row: existing, outcome: 'unchanged', dispatch: false };
            const row = await this.applyProcessing(originAppId, input.uri, input.processing);
            return { row, outcome: 'unchanged', dispatch: hasPendingStage(row.processing) };
        }

        let read: SourceRead;
        if (ref.space && delegation) {
            const opened = await this.spaces.open(ref.space, delegation);
            if (!opened.ok) throw spaceRefusal(opened, input.uri);
            read = await this.readFetched(originAppId, input.uri, ref, bytesFrom === 'fetch', opened.reader, ref.space);
        } else if (ref.space) {
            read = await this.readPushed(originAppId, input.uri, ref, ref.space, input.record!, input.cid);
        } else {
            read = await this.readFetched(originAppId, input.uri, ref, bytesFrom === 'fetch', this.repo, null);
        }
        if (!read.ok) throw this.refusal(read, input.uri);
        if (read.write.cid !== input.cid) {
            throw new ServiceError(
                `The record's current CID is ${read.write.cid}, not ${input.cid}; it changed since it was read`,
                409,
                { currentCid: read.write.cid },
                REMOTE_CID_MISMATCH,
            );
        }

        if (read.publish) await this.deps.makeBlobPublic(originAppId, read.write.blob.cid);
        const processing = this.nextProcessing(existing, read.write, input.processing);
        await this.deps.saveRemotePost({ ...read.write, processing });
        const row = (await this.deps.getRemotePost(originAppId, input.uri))!;
        return {
            row,
            outcome: existing ? 'updated' : 'created',
            dispatch: hasPendingStage(row.processing),
        };
    }

    /** One registered post, or 404 / 410. */
    async get(originAppId: string, uri: string): Promise<RemotePostRow> {
        const row = await this.deps.getRemotePost(originAppId, uri);
        if (row) return row;
        const deleted = await this.deps.getDeletedRemotePost(originAppId, uri);
        if (deleted) {
            throw new ServiceError(
                deleted.reason === 'gone'
                    ? 'The record was deleted from its repo, so this registration was removed'
                    : 'This registration was removed',
                410,
                { deletedAt: deleted.deletedAt.toISOString(), reason: deleted.reason },
                REMOTE_POST_DELETED,
            );
        }
        throw notRegistered(uri);
    }

    /** Request processing after registration; returns the row and whether to dispatch. */
    async requestProcessing(
        originAppId: string,
        uri: string,
        resolved: ResolvedProcessing,
    ): Promise<{ row: RemotePostRow; dispatch: boolean }> {
        await this.get(originAppId, uri);
        const row = await this.applyProcessing(originAppId, uri, resolved);
        return { row, dispatch: hasPendingStage(row.processing) };
    }

    /** Remove a registration and Antiphony's copy. Idempotent: false if there was none. */
    delete(originAppId: string, uri: string): Promise<boolean> {
        return this.deps.deleteRemotePost(originAppId, uri, 'tenant');
    }

    /** The registered replies under `rootUri`, with the root itself on the first page. */
    async thread(
        originAppId: string,
        rootUri: string,
        page: { limit: number; cursor?: string },
    ): Promise<{ root: RemotePostRow | null; replies: RemotePostRow[]; nextCursor: string | null }> {
        const limit = Math.max(1, Math.min(page.limit, MAX_REMOTE_THREAD_PAGE));
        const [root, replies] = await Promise.all([
            page.cursor ? Promise.resolve(null) : this.deps.getRemotePost(originAppId, rootUri),
            this.deps.listThread(originAppId, rootUri, { limit, cursor: page.cursor }),
        ]);
        return { root, replies: replies.items, nextCursor: replies.nextCursor };
    }

    /**
     * One page of the tenant's registered posts, newest first, optionally only
     * those in one repo, in one space, or of one kind. `cursor` is set when
     * another page follows.
     */
    async list(
        originAppId: string,
        filter: RemotePostFilter,
        page: { limit: number; cursor?: string },
    ): Promise<{ rows: RemotePostRow[]; cursor?: string }> {
        const limit = Math.max(1, Math.min(page.limit, MAX_REMOTE_LIST_PAGE));
        const after = page.cursor !== undefined ? decodeRemoteListCursor(page.cursor) : undefined;
        const { items, next } = await this.deps.listRemotePosts(originAppId, filter, { limit, ...(after ? { after } : {}) });
        return { rows: items, ...(next ? { cursor: encodeRemoteListCursor(next) } : {}) };
    }

    /**
     * The tenant's registered posts among `uris`, in the order asked for.
     * A URI that isn't registered (or was removed) is left out, and a repeated
     * one is returned once.
     */
    async getMany(originAppId: string, uris: string[]): Promise<RemotePostRow[]> {
        const wanted = [...new Set(uris)];
        if (wanted.length === 0) return [];
        const found = new Map((await this.deps.getRemotePosts(originAppId, wanted)).map((row) => [row.uri, row]));
        return wanted.map((uri) => found.get(uri)).filter((row): row is RemotePostRow => row !== undefined);
    }

    /** Views for one tenant's rows, transcripts loaded in one round. */
    async hydrate(originAppId: string, rows: RemotePostRow[]): Promise<RemotePostView[]> {
        if (rows.length === 0) return [];
        const transcripts = await this.deps.getTranscripts(
            originAppId,
            rows.map((r) => r.uri),
        );
        return Promise.all(rows.map((row) => this.view(row, transcripts)));
    }

    /**
     * Recheck the least recently checked repo records against their repos
     * (§8.1), then ask tenants to recheck their spaces.
     *
     * A space record can't be read without a fresh delegation, so the sweep
     * never reads one. It sends `remote.recheck_requested` for each space whose
     * oldest check is over `REMOTE_RECHECK_REQUEST_AFTER_MS` old, and the tenant
     * answers with `recheckSpace`. Only spaces holding a row Antiphony has read
     * on a delegation are asked about: a tenant that only pushes (Phase B)
     * isn't asked for what it never offered, though it may recheck anyway.
     *
     * For each repo record:
     *  - present, same CID: noted.
     *  - present, new CID: the record was edited. Re-read and re-store it; a
     *    new blob is copied and reprocessed. An edit that leaves no acceptable
     *    audio post removes the registration as gone.
     *  - gone: noted the first time; removed once a second read, at least
     *    `REMOTE_GONE_CONFIRM_MS` later, says the same.
     *  - unreachable: noted, never removed. Past `REMOTE_UNAVAILABLE_AFTER_MS`
     *    the post stops being served, and it is reported here.
     */
    async sweep(limit: number): Promise<SweepResult> {
        const result: SweepResult = { checked: 0, removed: 0, changed: 0, toDispatch: [], rechecksRequested: 0 };
        for (const due of await this.deps.listForSweep(limit)) {
            result.checked++;
            await this.recheckRow(due, result, this.repo);
        }

        const now = this.deps.now();
        const cutoff = new Date(now.getTime() - REMOTE_RECHECK_REQUEST_AFTER_MS);
        for (const due of await this.deps.listSpacesDue(cutoff, limit)) {
            const space = spaceUriOf(due.space);
            if (now.getTime() - due.oldestCheck.getTime() >= REMOTE_UNAVAILABLE_AFTER_MS) {
                this.logger.warn(
                    { originAppId: due.originAppId, space, oldestCheck: due.oldestCheck.toISOString() },
                    '[remote-posts] space not rechecked within the retention bound; its tenant has not answered',
                );
            }
            await this.emit({
                type: 'remote.recheck_requested',
                originAppId: due.originAppId,
                uri: space,
                space,
                occurredAt: now.toISOString(),
            });
            result.rechecksRequested++;
        }
        return result;
    }

    /**
     * Recheck this tenant's rows in one space on a fresh delegation (§8.1,
     * Phase C): one credential exchange, then each due row read from its
     * writer's PDS, as the sweep reads a repo record. A pushed row that reads
     * back with the same CID becomes `fetched`. A deleted space counts as a
     * "gone" read of every row in it.
     *
     * Throws for a delegation the authority refuses (403), or an authority it
     * can't reach (503); nothing changes then.
     */
    async recheckSpace(
        originAppId: string,
        spaceUri: string,
        delegation: SpaceDelegation,
        limit: number = MAX_RECHECK_ROWS,
    ): Promise<RecheckResult> {
        const space = parseRemoteSpaceUri(spaceUri);
        const max = Math.max(1, Math.min(limit, MAX_RECHECK_ROWS));
        const cutoff = new Date(this.deps.now().getTime() - REMOTE_RECHECK_DUE_AFTER_MS);
        const due = await this.deps.listSpaceRows(originAppId, space, cutoff, max + 1);
        const batch = due.slice(0, max);
        const result: RecheckResult = {
            space: spaceUri,
            checked: 0,
            removed: 0,
            changed: 0,
            toDispatch: [],
            remaining: due.length > max,
        };
        if (batch.length === 0) return result;

        const opened = await this.spaces.open(space, delegation);
        if (!opened.ok) {
            if (opened.kind !== 'deleted') throw spaceRefusal(opened, spaceUri);
            for (const row of batch) {
                result.checked++;
                await this.goneRead(row, result, opened.reason);
            }
            return result;
        }

        for (const [i, row] of batch.entries()) {
            if (this.deps.now().getTime() >= opened.reader.expiresAt - CREDENTIAL_MARGIN_MS) {
                result.remaining = true;
                this.logger.warn({ originAppId, space: spaceUri, left: batch.length - i }, '[remote-posts] credential ran out mid-recheck');
                break;
            }
            result.checked++;
            await this.recheckRow(row, result, opened.reader);
        }
        return result;
    }

    // --- internals --------------------------------------------------------

    /** One row's recheck. Its failure is not the caller's: the row stays due. */
    private async recheckRow(due: RemoteSweepRow, result: Omit<SweepResult, 'rechecksRequested'>, source: RecordSource): Promise<void> {
        try {
            await this.recheck(due, result, source);
        } catch (err) {
            this.logger.error({ err, originAppId: due.originAppId, uri: due.uri }, '[remote-posts] recheck failed');
        }
    }

    private async recheck(
        due: RemoteSweepRow,
        result: Omit<SweepResult, 'rechecksRequested'>,
        source: RecordSource,
    ): Promise<void> {
        const { originAppId, uri, cid, unreachableSince } = due;
        const now = this.deps.now();
        const ref = parseRemotePostUri(uri);
        // A space record is read only through a credential for its space.
        if (ref.space && source === this.repo) return;
        const fetched = await source.getRecord(ref);

        if (fetched.ok) {
            const recomputed = await this.deps.cidForRepoRecord(fetched.value.value);
            if (recomputed === cid && fetched.value.cid === cid) {
                await this.deps.recordCheck(originAppId, uri, 'present');
                // Read on a credential, a pushed record is now verified.
                if (due.verified === 'pushed') await this.deps.markFetched(originAppId, uri);
                return;
            }
            // Edited. Re-read it the way registration does.
            const read = await this.readFetched(originAppId, uri, ref, true, source, ref.space);
            if (read.ok) {
                if (read.publish) await this.deps.makeBlobPublic(originAppId, read.write.blob.cid);
                const existing = await this.deps.getRemotePost(originAppId, uri);
                const processing = this.nextProcessing(existing, read.write, undefined);
                await this.deps.saveRemotePost({ ...read.write, processing });
                result.changed++;
                if (hasPendingStage(processing)) result.toDispatch.push({ originAppId, uri });
                await this.emit({ type: 'remote.changed', originAppId, uri, cid: read.write.cid, occurredAt: now.toISOString() });
                return;
            }
            if (read.kind === 'unreachable') {
                await this.deps.recordCheck(originAppId, uri, 'unreachable');
                return;
            }
            // The edit left something Antiphony can't hold as an audio post (no
            // audio, or a different blob it can't verify). Its
            // copy of the old version must not outlive the record that had it.
            await this.remove(originAppId, uri, now, result, read.reason);
            return;
        }

        if (fetched.kind === 'gone') {
            await this.goneRead(due, result, fetched.reason);
            return;
        }

        // Unreachable, or an answer that couldn't be read: absence of evidence.
        await this.deps.recordCheck(originAppId, uri, 'unreachable');
        const since = unreachableSince ?? now;
        if (now.getTime() - since.getTime() >= REMOTE_UNAVAILABLE_AFTER_MS) {
            this.logger.warn(
                { originAppId, uri, unreachableSince: since.toISOString(), reason: fetched.reason },
                '[remote-posts] repo unreachable past the retention bound; the post is no longer served',
            );
        }
    }

    /** A "gone" read: noted the first time, removed once a second read an hour later agrees. */
    private async goneRead(due: RemoteSweepRow, result: Omit<SweepResult, 'rechecksRequested'>, reason: string): Promise<void> {
        const now = this.deps.now();
        if (due.goneAt && now.getTime() - due.goneAt.getTime() >= REMOTE_GONE_CONFIRM_MS) {
            await this.remove(due.originAppId, due.uri, now, result, reason);
        } else {
            await this.deps.recordCheck(due.originAppId, due.uri, 'gone');
        }
    }

    private async remove(
        originAppId: string,
        uri: string,
        now: Date,
        result: Omit<SweepResult, 'rechecksRequested'>,
        reason: string,
    ): Promise<void> {
        if (await this.deps.deleteRemotePost(originAppId, uri, 'gone')) {
            result.removed++;
            this.logger.info({ originAppId, uri, reason }, '[remote-posts] source gone; removed');
            await this.emit({ type: 'remote.gone', originAppId, uri, occurredAt: now.toISOString() });
        }
    }

    private async emit(event: Parameters<RemoteNotifierPort['notifyRemote']>[0]): Promise<void> {
        try {
            await this.notifier.notifyRemote(event);
        } catch (err) {
            this.logger.error({ err, ...event }, '[remote-posts] webhook failed; swallowed (row already changed)');
        }
    }

    /**
     * Read a record and its blob from its source, and check both: the record
     * hashes to the CID its source reports, it is an acceptable audio post, and
     * the blob's bytes hash to its ref and are audio. The blob is copied unless
     * this tenant already stores those bytes (and with `download` false, it
     * must already).
     *
     * **A repo record** (`space` null). Bytes stored private here (a space's)
     * are a verified public reference's to make public (§7), but only once the
     * repo has served those same bytes: a public record naming a CID proves
     * nothing until its repo has the blob. So they are downloaded and checked
     * then, whatever `download` says.
     *
     * **A space record**, read on a credential. Its bytes are stored private for
     * that space, and stored bytes must be marked for it, as for a pushed record.
     * It never turns anything public.
     */
    private async readFetched(
        originAppId: string,
        uri: string,
        ref: RepoRecordRef,
        download: boolean,
        source: RecordSource,
        space: RemoteSpace | null,
    ): Promise<SourceRead> {
        const fetched = await source.getRecord(ref);
        if (!fetched.ok) return fetched;

        const recomputed = await this.deps.cidForRepoRecord(fetched.value.value);
        if (recomputed !== fetched.value.cid) {
            return {
                ok: false,
                kind: 'invalid',
                reason: `the repo reported CID ${fetched.value.cid} for a record that hashes to ${recomputed}`,
            };
        }

        const parsed = RemoteAudioPostRecordSchema.safeParse(fetched.value.value);
        if (!parsed.success) return { ok: false, kind: 'invalid', reason: notAnAudioPost(parsed.error.issues) };
        const record = parsed.data;
        const blobCid = record.embed.audio.ref.$link;

        let mimeType = record.embed.audio.mimeType;
        let size = record.embed.audio.size;
        const stored = await this.deps.getStoredBlob(originAppId, blobCid);
        if (space) {
            if (stored) {
                const refused = await this.spaceMarkingRefusal(originAppId, stored.space, space, blobCid);
                if (refused) return refused;
            } else {
                if (!download) {
                    return { ok: false, kind: 'invalid', reason: `bytesFrom "upload": this tenant has not uploaded the blob ${blobCid}` };
                }
                const blob = await this.downloadBlob(source, ref.did, blobCid);
                if (!blob.ok) return blob;
                ({ mimeType, size } = blob);
                const kept = await this.deps.storeBlob(originAppId, blobCid, blob.bytes, blob.mimeType, space);
                const refused = await this.spaceMarkingRefusal(originAppId, kept.space, space, blobCid);
                if (refused) return refused;
            }
            return {
                ok: true,
                publish: false,
                write: {
                    originAppId,
                    uri,
                    cid: fetched.value.cid,
                    repoDid: ref.did,
                    collection: ref.collection,
                    rkey: ref.rkey,
                    space,
                    verified: 'fetched',
                    record,
                    blob: { cid: blobCid, mimeType, size },
                    blobPrivate: true,
                    createdAt: new Date(record.createdAt),
                },
            };
        }

        let publish = false;
        if (!stored || stored.space) {
            if (!stored && !download) {
                return {
                    ok: false,
                    kind: 'invalid',
                    reason: `bytesFrom "upload": this tenant has not uploaded the blob ${blobCid}`,
                };
            }
            const blob = await this.downloadBlob(source, ref.did, blobCid);
            if (!blob.ok) return blob;
            ({ mimeType, size } = blob);
            // Private bytes are already here, so nothing is stored; else the
            // copy is kept public, unless private bytes appeared meanwhile.
            const kept = stored ?? (await this.deps.storeBlob(originAppId, blobCid, blob.bytes, blob.mimeType));
            publish = kept.space !== null;
        }

        return {
            ok: true,
            publish,
            write: {
                originAppId,
                uri,
                cid: fetched.value.cid,
                repoDid: ref.did,
                collection: ref.collection,
                rkey: ref.rkey,
                space: null,
                verified: 'fetched',
                record,
                blob: { cid: blobCid, mimeType, size },
                blobPrivate: false,
                createdAt: new Date(record.createdAt),
            },
        };
    }

    /** Download a blob from its source and check it: its bytes hash to the ref and are audio. */
    private async downloadBlob(
        source: RecordSource,
        repoDid: string,
        blobCid: string,
    ): Promise<{ ok: true; bytes: Uint8Array; mimeType: string; size: number } | Extract<SourceRead, { ok: false }>> {
        const blob = await source.getBlob(repoDid, blobCid, MAX_REMOTE_BLOB_BYTES);
        if (!blob.ok) {
            // A record whose blob its own repo doesn't have can't be served.
            return blob.kind === 'unreachable' ? blob : { ok: false, kind: 'invalid', reason: `blob: ${blob.reason}` };
        }
        const actual = await this.deps.cidForBytes(blob.value.bytes);
        if (actual !== blobCid) {
            return { ok: false, kind: 'invalid', reason: `blob bytes hash to ${actual}, not ${blobCid}` };
        }
        const sniffed = sniffAudioMime(blob.value.bytes);
        if (!sniffed) return { ok: false, kind: 'invalid', reason: 'blob is not audio Antiphony serves' };
        return { ok: true, bytes: blob.value.bytes, mimeType: sniffed, size: blob.value.bytes.byteLength };
    }

    /**
     * Whether stored bytes may be a space record's audio: marked private for
     * exactly that space, or public because a verified public record already
     * references them (§7). Null when they may; the refusal otherwise.
     */
    private async spaceMarkingRefusal(
        originAppId: string,
        marking: ScopedSpaceKey | null,
        space: RemoteSpace,
        blobCid: string,
    ): Promise<Extract<SourceRead, { ok: false }> | null> {
        if (marking && !markedFor(marking, space)) {
            return { ok: false, kind: 'mismatch', reason: `the blob ${blobCid} is stored private for another space` };
        }
        if (!marking && !(await this.deps.hasVerifiedPublicReference(originAppId, blobCid))) {
            return {
                ok: false,
                kind: 'mismatch',
                reason: `the blob ${blobCid} is stored public, and no verified public record references it`,
            };
        }
        return null;
    }

    /**
     * Check a space record the tenant pushed (Phase B, §4.2): the body hashes
     * to `cid` and is an acceptable audio post, and its blob is bytes this
     * tenant uploaded, stored private for this same space. Nothing is fetched.
     *
     * Bytes stored public are refused unless a verified public record already
     * references them: then they are public anyway (§7), and refusing would
     * make the outcome depend on which record was registered first. Bytes that
     * are public only because they were uploaded without `remoteSpace` would
     * give a space record's audio a stable, unsigned URL, so they are refused.
     */
    private async readPushed(
        originAppId: string,
        uri: string,
        ref: RepoRecordRef,
        space: RemoteSpace,
        body: Record<string, unknown>,
        cid: string,
    ): Promise<SourceRead> {
        const recomputed = await this.deps.cidForRepoRecord(body);
        if (recomputed !== cid) {
            return { ok: false, kind: 'invalid', reason: `the record hashes to ${recomputed}, not ${cid}` };
        }
        const parsed = RemoteAudioPostRecordSchema.safeParse(body);
        if (!parsed.success) return { ok: false, kind: 'invalid', reason: notAnAudioPost(parsed.error.issues) };
        const record: RemoteAudioPostRecord = parsed.data;
        const blobCid = record.embed.audio.ref.$link;

        const stored = await this.deps.getStoredBlob(originAppId, blobCid);
        if (!stored) {
            return {
                ok: false,
                kind: 'invalid',
                reason: `this tenant has not uploaded the blob ${blobCid}; upload it with remoteSpace first`,
            };
        }
        const refused = await this.spaceMarkingRefusal(originAppId, stored.space, space, blobCid);
        if (refused) return refused;

        return {
            ok: true,
            publish: false,
            write: {
                originAppId,
                uri,
                cid,
                repoDid: ref.did,
                collection: ref.collection,
                rkey: ref.rkey,
                space,
                verified: 'pushed',
                record,
                blob: { cid: blobCid, mimeType: record.embed.audio.mimeType, size: record.embed.audio.size },
                // A space record plays from signed URLs only, whatever its bytes' marking.
                blobPrivate: true,
                createdAt: new Date(record.createdAt),
            },
        };
    }

    /**
     * The processing state to store with a fresh read. Unchanged audio keeps
     * its state. New audio makes every artifact of the old one wrong, so each
     * stage that was requested is requested again, from scratch. A request in
     * this call is merged on top.
     */
    private nextProcessing(
        existing: RemotePostRow | null,
        write: RemotePostWrite,
        requested: ResolvedProcessing | undefined,
    ): ProcessingState | undefined {
        const now = this.deps.now();
        let base: Partial<ProcessingState> | undefined;
        if (existing?.processing) {
            if (existing.blob.cid === write.blob.cid) {
                base = existing.processing;
            } else {
                base = { reprocess: existing.processing.reprocess };
                for (const stage of PROCESSING_STAGES) {
                    if (existing.processing[stage]) base[stage] = 'pending';
                }
            }
        }
        if (!base && !requested) return undefined;
        return { ...base, ...requested, updatedAt: now } as ProcessingState;
    }

    private async applyProcessing(originAppId: string, uri: string, resolved: ResolvedProcessing): Promise<RemotePostRow> {
        await this.deps.mergeProcessing(originAppId, uri, resolved);
        const row = await this.deps.getRemotePost(originAppId, uri);
        if (!row) throw notRegistered(uri);
        return row;
    }

    private refusal(read: Extract<SourceRead, { ok: false }>, uri: string): ServiceError {
        switch (read.kind) {
            case 'gone':
                return new ServiceError(`The record's repo says it doesn't exist: ${uri}`, 404, { reason: read.reason }, REMOTE_RECORD_NOT_FOUND);
            case 'unreachable':
                return new ServiceError(`Couldn't read ${uri} from its repo right now; try again`, 503, { reason: read.reason }, REMOTE_REPO_UNREACHABLE);
            case 'mismatch':
                return new ServiceError(
                    `Can't accept ${uri}: ${read.reason}. Upload its audio with \`remoteSpace\` naming the record's space`,
                    409,
                    { reason: read.reason },
                    REMOTE_BLOB_SPACE_MISMATCH,
                );
            case 'invalid':
                return new ServiceError(`Can't accept ${uri}: ${read.reason}`, 422, { reason: read.reason }, REMOTE_RECORD_INVALID);
        }
    }

    private async view(row: RemotePostRow, transcripts: Map<string, TranscriptEnrichmentRecord>): Promise<RemotePostView> {
        const available =
            !row.unreachableSince || this.deps.now().getTime() - row.unreachableSince.getTime() < REMOTE_UNAVAILABLE_AFTER_MS;
        const { record } = row;

        let embed: RemotePostView['embed'];
        if (available) {
            const resolved = resolveAudioVariant(
                { blobCid: row.blob.cid, durationMs: record.embed.durationMs, waveform: record.embed.waveform },
                row.processing,
            );
            const url = await this.deps.resolveAudioUrl(row.originAppId, resolved.blobCid, row.blobPrivate);
            if (url) {
                embed = {
                    $type: 'dev.antiphony.embed.audio#view',
                    url,
                    durationMs: resolved.durationMs,
                    alt: record.embed.alt,
                    waveform: resolved.waveform,
                    transcript: transcripts.get(row.uri)?.transcript,
                    processing: row.processing ? toProcessingView(row.processing) : undefined,
                };
            }
        }

        return {
            uri: row.uri,
            cid: row.cid,
            kind: record.reply ? 'reply' : 'prompt',
            authorDid: row.repoDid,
            ...(row.space ? { space: row.space } : {}),
            verified: row.verified,
            deletionCheck: row.verified === 'pushed' ? 'tenant' : row.space ? 'recheck' : 'sweep',
            record: {
                text: record.text,
                title: record.title,
                reply: record.reply,
                langs: record.langs,
                selfLabels: record.labels?.values.map((v) => v.val),
                createdAt: row.createdAt,
            },
            embed,
            available,
            registeredAt: row.registeredAt.toISOString(),
        };
    }
}

/** The delegation a registration carries, if any. */
function delegationOf(input: RegisterInput): SpaceDelegation | undefined {
    if (!input.delegationToken) return undefined;
    return {
        delegationToken: input.delegationToken,
        ...(input.clientAttestation ? { clientAttestation: input.clientAttestation } : {}),
    };
}

/** A space's URI, `at://{authority}/space/{type}/{skey}`. */
export function spaceUriOf(space: RemoteSpace): string {
    return `at://${space.authority}/space/${space.type}/${space.skey}`;
}

/** What a failed credential exchange tells the caller. */
function spaceRefusal(opened: Extract<SpaceOpenResult, { ok: false }>, subject: string): ServiceError {
    switch (opened.kind) {
        case 'refused':
            return new ServiceError(
                `The space's authority refused this delegation for ${subject}: its member may not read the space, ` +
                    'or the token was already spent or expired',
                403,
                { reason: opened.reason },
                REMOTE_DELEGATION_REFUSED,
            );
        case 'deleted':
            return new ServiceError(`The space was deleted: ${subject}`, 404, { reason: opened.reason }, REMOTE_RECORD_NOT_FOUND);
        case 'unreachable':
            return new ServiceError(
                `Couldn't reach the space's authority for ${subject} right now; try again with a fresh delegation`,
                503,
                { reason: opened.reason },
                REMOTE_REPO_UNREACHABLE,
            );
        case 'invalid':
            return new ServiceError(`Can't read the space for ${subject}: ${opened.reason}`, 422, { reason: opened.reason }, REMOTE_RECORD_INVALID);
    }
}

function notAnAudioPost(issues: { path: PropertyKey[]; message: string }[]): string {
    const first = issues[0];
    return `not an audio post: ${first?.path.join('.') || 'record'}: ${first?.message ?? 'invalid'}`;
}

function notRegistered(uri: string): ServiceError {
    return new ServiceError(`No registered remote post at ${uri}`, 404, undefined, REMOTE_POST_NOT_FOUND);
}
