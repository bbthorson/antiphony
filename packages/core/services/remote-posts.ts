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
import type { RemotePostDependencies, RemotePostRow, RemotePostWrite } from '../ports/remote-posts-dependencies';
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
 * 400: the URI isn't an audio post record Antiphony can register, or it names a
 * space record to be fetched (Antiphony can't read a space before Phase C).
 */
export const REMOTE_URI_UNSUPPORTED = 'REMOTE_URI_UNSUPPORTED';
/** 400: `record` was missing for a space record, or sent for a repo record. */
export const REMOTE_REQUEST_INVALID = 'REMOTE_REQUEST_INVALID';
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
    /** The record body, for a space record (Phase B); refused for a repo record. */
    record?: Record<string, unknown>;
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
}

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
 *  - **A space record** (Phase B) can't be read here, so the tenant pushes it:
 *    the record body, which must hash to the CID, and bytes it uploaded with
 *    `remoteSpace` naming the same space. That proves content, not access, and
 *    tenant scoping is what contains a made-up one (open question 3). The sweep
 *    can't read it either: the tenant's DELETE is its only deletion signal.
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
    ) {}

    async register(originAppId: string, input: RegisterInput): Promise<RegisterResult> {
        const ref = parseRemotePostUri(input.uri);
        const bytesFrom = input.bytesFrom ?? (ref.space ? 'upload' : 'fetch');
        if (ref.space && bytesFrom === 'fetch') {
            throw new ServiceError(
                `Antiphony can't read a space record yet; push it with \`bytesFrom: "upload"\` and \`record\`: ${input.uri}`,
                400,
                undefined,
                REMOTE_URI_UNSUPPORTED,
            );
        }
        if (ref.space && !input.record) {
            throw new ServiceError('A space record is registered with its `record` body', 400, undefined, REMOTE_REQUEST_INVALID);
        }
        if (!ref.space && input.record) {
            throw new ServiceError(
                "A repo record is read from its repo; don't send `record`",
                400,
                undefined,
                REMOTE_REQUEST_INVALID,
            );
        }
        const existing = await this.deps.getRemotePost(originAppId, input.uri);

        // A repeat of what's registered: nothing to fetch. A processing request
        // still applies, as it would through PATCH.
        if (existing && existing.cid === input.cid) {
            if (!input.processing) return { row: existing, outcome: 'unchanged', dispatch: false };
            const row = await this.applyProcessing(originAppId, input.uri, input.processing);
            return { row, outcome: 'unchanged', dispatch: hasPendingStage(row.processing) };
        }

        const read = ref.space
            ? await this.readPushed(originAppId, input.uri, ref, ref.space, input.record!, input.cid)
            : await this.readSource(originAppId, input.uri, ref, bytesFrom === 'fetch');
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
     * Recheck the least recently checked rows against their repos (§8.1).
     * Only rows Antiphony fetched: a pushed space record can't be read here.
     *
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
        const result: SweepResult = { checked: 0, removed: 0, changed: 0, toDispatch: [] };
        for (const due of await this.deps.listForSweep(limit)) {
            result.checked++;
            try {
                await this.recheck(due.originAppId, due.uri, due.cid, due.goneAt, due.unreachableSince, result);
            } catch (err) {
                // One row's failure is not the sweep's: the row stays due and the
                // next run tries it again.
                this.logger.error({ err, originAppId: due.originAppId, uri: due.uri }, '[remote-posts] recheck failed');
            }
        }
        return result;
    }

    // --- internals --------------------------------------------------------

    private async recheck(
        originAppId: string,
        uri: string,
        cid: string,
        goneAt: Date | null,
        unreachableSince: Date | null,
        result: SweepResult,
    ): Promise<void> {
        const now = this.deps.now();
        const ref = parseRemotePostUri(uri);
        // `listForSweep` returns fetched rows only, and before Phase C every
        // space record is pushed. Should one get here, leave it alone.
        if (ref.space) return;
        const fetched = await this.repo.getRecord(ref);

        if (fetched.ok) {
            const recomputed = await this.deps.cidForRepoRecord(fetched.value.value);
            if (recomputed === cid && fetched.value.cid === cid) {
                await this.deps.recordCheck(originAppId, uri, 'present');
                return;
            }
            // Edited. Re-read it the way registration does.
            const read = await this.readSource(originAppId, uri, ref, true);
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
            if (goneAt && now.getTime() - goneAt.getTime() >= REMOTE_GONE_CONFIRM_MS) {
                await this.remove(originAppId, uri, now, result, fetched.reason);
            } else {
                await this.deps.recordCheck(originAppId, uri, 'gone');
            }
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

    private async remove(
        originAppId: string,
        uri: string,
        now: Date,
        result: SweepResult,
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
     * Read a public record and its blob from the source, and check both: the
     * record hashes to the CID its repo reports, it is an acceptable audio post,
     * and the blob's bytes hash to its ref and are audio. The blob is copied
     * unless this tenant already stores those bytes (and with `download` false,
     * it must already).
     *
     * Bytes stored private here (a space's) are a verified public reference's
     * to make public (§7), but only once the repo has served those same bytes:
     * a public record naming a CID proves nothing until its repo has the blob.
     * So they are downloaded and checked then, whatever `download` says.
     */
    private async readSource(originAppId: string, uri: string, ref: RepoRecordRef, download: boolean): Promise<SourceRead> {
        const fetched = await this.repo.getRecord(ref);
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
        let publish = false;
        if (!stored || stored.space) {
            if (!stored && !download) {
                return {
                    ok: false,
                    kind: 'invalid',
                    reason: `bytesFrom "upload": this tenant has not uploaded the blob ${blobCid}`,
                };
            }
            const blob = await this.repo.getBlob(ref.did, blobCid, MAX_REMOTE_BLOB_BYTES);
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
            mimeType = sniffed;
            size = blob.value.bytes.byteLength;
            // Private bytes are already here, so nothing is stored; else the
            // copy is kept public, unless private bytes appeared meanwhile.
            const kept = stored ?? (await this.deps.storeBlob(originAppId, blobCid, blob.value.bytes, sniffed));
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
        if (stored.space && !markedFor(stored.space, space)) {
            return { ok: false, kind: 'mismatch', reason: `the blob ${blobCid} is stored private for another space` };
        }
        if (!stored.space && !(await this.deps.hasVerifiedPublicReference(originAppId, blobCid))) {
            return {
                ok: false,
                kind: 'mismatch',
                reason: `the blob ${blobCid} is stored public, and no verified public record references it`,
            };
        }

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
            deletionCheck: row.verified === 'pushed' ? 'tenant' : 'sweep',
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

function notAnAudioPost(issues: { path: PropertyKey[]; message: string }[]): string {
    const first = issues[0];
    return `not an audio post: ${first?.path.join('.') || 'record'}: ${first?.message ?? 'invalid'}`;
}

function notRegistered(uri: string): ServiceError {
    return new ServiceError(`No registered remote post at ${uri}`, 404, undefined, REMOTE_POST_NOT_FOUND);
}
