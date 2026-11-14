import { createDidResolver } from '@atproto-labs/did-resolver';
import { lexToJson } from '@atproto/lex-json';
import { l } from '@atproto/lex-schema';
import { SpaceReader } from '@atproto/lex-space';
import type { DidString, NsidString, SpaceRefString } from '@atproto/syntax';
import type { FetchedBlob, FetchedRecord, RepoResult } from '@antiphony/core/ports/public-repo';
import type { SpaceOpenResult, SpaceReader as SpaceReaderPort, SpaceRepoPort } from '@antiphony/core/ports/space-repo';
import { spaceUriOf } from '@antiphony/core/services/remote-posts';
import { type DidDocumentResolverOptions, errorText } from './did-document.js';

/**
 * `SpaceRepoPort` over `@atproto/lex-space`'s `SpaceReader`
 * (specs/audio-service-mode.md §4.2, Phase C; specs/spaces-beta-readiness.md,
 * "Upstream packages"). The library speaks the protocol; this file keeps
 * Antiphony's network policy and its classification of what went wrong.
 *
 * ## What the library does
 *
 * `authorize()` spends the tenant's delegation token at the authority's
 * `#atproto_pds` (`com.atproto.space.authorizeSpaceSync`) for a credential bound
 * to a P-256 key it makes and never exports. `getRecord` goes to the writer's
 * PDS, signed for the writer, with an HPKE-keyed MAC request against the
 * writer's `#atproto_kem`, and verifies the MAC and the record's CID. `getBlob`
 * verifies the bytes against their CID. No notifications are registered: a
 * reader is for one call's work and is dropped with its key.
 *
 * ## What stays here
 *
 * - **The network policy**, in `guardedFetch`, which every request the library
 *   makes goes through (DID documents included): HTTPS only, no redirects, a
 *   timeout per request, and a byte cap on blobs. The library buffers a blob
 *   whole with no cap of its own, so the cap is enforced on the stream it reads.
 * - **The delegation is spent once.** The token is single use. When a writer's
 *   host rejects the credential, the library asks for a fresh one; the second
 *   request for the token throws, which reads as `unreachable`, as a writer's 401
 *   always did.
 * - **The record comes back as JSON** (`lexToJson`): the library hands back lex
 *   values, with CID objects where the wire had `{ "$link": … }`, and the core
 *   parses and hashes JSON.
 * - **Classification**, as `public-repo.ts`, plus the exchange's answers about the
 *   space: `SpaceDeleted` is `deleted`; `SpaceNotFound` (also a host's answer to a
 *   delegation it won't honour) and the token errors are `refused`, never gone.
 *   `UpstreamFailure` (a managed space's app didn't answer) and a suspended
 *   authority (`RepoTakendown`, `RepoDeactivated`) are `unreachable`. A writer's
 *   host that rejects the credential is `unreachable`: it says nothing about the
 *   record.
 */

const DOC_TIMEOUT_MS = 5_000;
const EXCHANGE_TIMEOUT_MS = 10_000;
const RECORD_TIMEOUT_MS = 10_000;
const BLOB_TIMEOUT_MS = 30_000;
/** Assumed when a credential's `exp` can't be read: the reference lifetime. */
const DEFAULT_CREDENTIAL_MS = 10 * 60 * 1000;

const GONE_ERRORS = new Set(['RecordNotFound', 'RepoNotFound', 'BlobNotFound']);
const REFUSED_ERRORS = new Set([
    'SpaceNotFound',
    'InvalidDelegationToken',
    'AppNotAuthorized',
    'NotAuthorized',
    'AccountNotAuthorized',
    'InvalidClientAttestation',
    'JwtReplayed',
]);
/** Answers that may change on a retry, whatever their status. */
const TRANSIENT_ERRORS = new Set(['UpstreamFailure', 'RepoTakendown', 'RepoDeactivated']);

/**
 * A space type schema built from the URI alone. Antiphony reads one record and
 * its blob by path, so it declares no collections and never validates against
 * them.
 */
const anySpace = (type: NsidString) => l.space('any', type, []);
type AnySpace = ReturnType<typeof anySpace>;

type Kind = 'gone' | 'unreachable' | 'invalid' | 'refused' | 'deleted';

/** A failure this file raises itself, carrying the kind it reads as. */
class PolicyError extends Error {
    constructor(
        readonly kind: Kind,
        message: string,
    ) {
        super(message);
        this.name = 'PolicyError';
    }
}

export type SpaceRepoOptions = DidDocumentResolverOptions;

export function spaceRepo(opts: SpaceRepoOptions = {}): SpaceRepoPort {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const now = opts.now ?? Date.now;

    return {
        async open(space, delegation): Promise<SpaceOpenResult> {
            const blobCaps = new Map<string, number>();
            const policyFetch = guardedFetch(fetchImpl, blobCaps);
            let spent = false;
            const reader = SpaceReader.openSpace(anySpace(space.type as NsidString), spaceUriOf(space) as SpaceRefString, {
                fetch: policyFetch,
                didResolver: createDidResolver({
                    fetch: policyFetch,
                    allowHttp: false,
                    ...(opts.plcDirectoryUrl ? { plcDirectoryUrl: opts.plcDirectoryUrl } : {}),
                }),
                delegationTokenProvider: async () => {
                    if (spent) throw new PolicyError('unreachable', "the writer's host rejected the credential, and the delegation is spent");
                    spent = true;
                    return delegation.delegationToken;
                },
                ...(delegation.clientAttestation ? { clientAttestationProvider: once(delegation.clientAttestation) } : {}),
            });

            let token: string;
            try {
                token = (await reader.authorize()).token;
            } catch (err) {
                const { kind, reason } = classify(err, 'authorizeSpaceSync');
                // A DID document that's gone for the authority means its spaces
                // can't be read, not that they were deleted: only `SpaceDeleted`
                // says that.
                return { ok: false, kind: kind === 'gone' ? 'unreachable' : kind, reason };
            }
            return { ok: true, reader: wrap(reader, token, blobCaps, now()) };
        },
    };
}

function wrap(reader: SpaceReader<AnySpace>, credential: string, blobCaps: Map<string, number>, nowMs: number): SpaceReaderPort {
    return {
        expiresAt: expiryOf(credential, nowMs),

        async getRecord(ref): Promise<RepoResult<FetchedRecord>> {
            try {
                const res = await reader.getRecord(ref.collection as NsidString, ref.rkey, { repo: ref.did as DidString });
                const { cid, value } = res.body;
                return { ok: true, value: { cid: String(cid), value: lexToJson(value) } };
            } catch (err) {
                return asRepoFailure(classify(err, 'space getRecord'));
            }
        },

        async getBlob(repoDid, cid, maxBytes): Promise<RepoResult<FetchedBlob>> {
            blobCaps.set(cid, maxBytes);
            try {
                const res = await reader.getBlob({ repo: repoDid as DidString, cid });
                return { ok: true, value: { bytes: res.body, contentType: res.headers.get('content-type') ?? undefined } };
            } catch (err) {
                return asRepoFailure(classify(err, 'space getBlob'));
            } finally {
                blobCaps.delete(cid);
            }
        },
    };
}

/**
 * Every request the library makes: HTTPS only, redirects not followed, a
 * timeout chosen by method, and a blob read stopped at its cap.
 */
function guardedFetch(fetchImpl: typeof fetch, blobCaps: Map<string, number>): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.protocol !== 'https:') throw new PolicyError('invalid', `${url.origin} is not HTTPS`);
        const method = url.pathname.startsWith('/xrpc/') ? url.pathname.slice('/xrpc/'.length) : null;
        const ms =
            method === 'com.atproto.space.getBlob'
                ? BLOB_TIMEOUT_MS
                : method === 'com.atproto.space.authorizeSpaceSync'
                  ? EXCHANGE_TIMEOUT_MS
                  : method
                    ? RECORD_TIMEOUT_MS
                    : DOC_TIMEOUT_MS;
        const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

        const res = await fetchImpl(input, { ...init, redirect: 'manual', signal });
        if (res.status >= 300 && res.status < 400) {
            await res.body?.cancel().catch(() => undefined);
            throw new PolicyError('unreachable', `${method ?? url.origin} answered a redirect, which isn't followed`);
        }

        const cap = method === 'com.atproto.space.getBlob' ? blobCaps.get(url.searchParams.get('cid') ?? '') : undefined;
        if (cap === undefined || !res.ok || !res.body) return res;
        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > cap) {
            await res.body.cancel().catch(() => undefined);
            throw new PolicyError('invalid', `blob is ${declared} bytes, over the ${cap} cap`);
        }
        let total = 0;
        const capped = res.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    total += chunk.byteLength;
                    if (total > cap) controller.error(new PolicyError('invalid', `blob is over the ${cap} cap`));
                    else controller.enqueue(chunk);
                },
            }),
        );
        return new Response(capped, { status: res.status, statusText: res.statusText, headers: res.headers });
    }) as typeof fetch;
}

/** What went wrong, from whichever layer said so. */
function classify(err: unknown, what: string): { kind: Kind; reason: string } {
    const policy = findCause(err, (e): e is PolicyError => e instanceof PolicyError);
    if (policy) return { kind: policy.kind, reason: `${what}: ${policy.message}` };

    // `XrpcResponseError` from `@atproto/lex-client`: the host answered with an
    // XRPC error. Duck-typed, so a second bundled copy of the class still matches.
    const xrpc = findCause(err, isXrpcResponseError);
    if (xrpc) {
        const name = xrpc.error;
        const status = xrpc.response.status;
        const reason = `${what}: ${status} ${name}`;
        if (name === 'SpaceDeleted') return { kind: 'deleted', reason };
        if (TRANSIENT_ERRORS.has(name)) return { kind: 'unreachable', reason };
        if (GONE_ERRORS.has(name) && (status === 400 || status === 404)) return { kind: 'gone', reason };
        if (REFUSED_ERRORS.has(name) && status >= 400 && status < 500) return { kind: 'refused', reason };
        if (status === 401 || status === 429 || status >= 500) return { kind: 'unreachable', reason };
        // Any other 4xx from the exchange is a refusal; from a writer's host, it
        // says nothing about the record.
        return { kind: what === 'authorizeSpaceSync' ? 'refused' : 'unreachable', reason };
    }

    // `DidError` from `@atproto/did`: resolving a DID document, or reading it.
    const did = findCause(err, isDidError);
    if (did) {
        const reason = `${what}: DID document for ${did.did}: ${did.message}`;
        switch (did.code) {
            case 'did-fetch-error':
                return { kind: did.status === 404 || did.status === 410 ? 'gone' : 'unreachable', reason };
            case 'did-service-not-found':
                return { kind: 'gone', reason };
            case 'did-document-id-mismatch':
                return { kind: 'unreachable', reason };
            default:
                // A malformed document, or one with no `#atproto_kem` for a MAC.
                return { kind: 'invalid', reason };
        }
    }

    // `SpaceRepoVerificationError`, `SpaceMacError`, `SpaceKemError` from
    // `@atproto/space`: a MAC, a record or a blob that doesn't check out.
    const verification = findCause(err, (e): e is Error => e instanceof Error && /^Space(RepoVerification|Mac|Kem)Error$/.test(e.name));
    if (verification) return { kind: 'invalid', reason: `${what}: ${verification.message}` };

    return { kind: 'unreachable', reason: `${what}: ${errorText(err)}` };
}

function asRepoFailure({ kind, reason }: { kind: Kind; reason: string }): { ok: false; kind: 'gone' | 'unreachable' | 'invalid'; reason: string } {
    return { ok: false, kind: kind === 'gone' || kind === 'invalid' ? kind : 'unreachable', reason };
}

function findCause<T>(err: unknown, test: (e: unknown) => e is T): T | undefined {
    for (let e: unknown = err, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
        if (test(e)) return e;
    }
    return undefined;
}

function isXrpcResponseError(e: unknown): e is { error: string; response: Response } {
    const x = e as { error?: unknown; response?: { status?: unknown } } | null;
    return !!x && typeof x.error === 'string' && typeof x.response?.status === 'number';
}

function isDidError(e: unknown): e is { did: string; code: string; status: number; message: string } {
    const d = e as { did?: unknown; code?: unknown; status?: unknown } | null;
    return !!d && typeof d.did === 'string' && typeof d.code === 'string' && d.code.startsWith('did-') && typeof d.status === 'number';
}

function once(value: string): () => Promise<string> {
    let used = false;
    return async () => {
        if (used) throw new PolicyError('unreachable', 'the client attestation is spent');
        used = true;
        return value;
    };
}

/** The credential's `exp`, in ms; the reference lifetime from now if it can't be read. */
function expiryOf(jwt: string, nowMs: number): number {
    try {
        const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
        if (typeof payload.exp === 'number') return payload.exp * 1000;
    } catch {
        // fall through
    }
    return nowMs + DEFAULT_CREDENTIAL_MS;
}
