import { P256Keypair } from '@atproto/crypto';
import {
    MAC_HEADER,
    RECORD_MAC_TYPE,
    WANT_MAC_HEADER,
    createSpaceSigHeaders,
    encapsulate,
    formatWantMacHeader,
    parseMacHeader,
    verifyRecordMac,
} from '@atproto/space';
import { CID } from 'multiformats/cid';
import type { FetchedBlob, FetchedRecord, RepoResult } from '@antiphony/core/ports/public-repo';
import type { SpaceOpenResult, SpaceReader, SpaceRepoPort } from '@antiphony/core/ports/space-repo';
import { spaceUriOf } from '@antiphony/core/services/remote-posts';
import {
    type DidDocument,
    type DidDocumentResolverOptions,
    didDocumentResolver,
    errorText,
    kemDidKeyOf,
    pdsEndpointOf,
    readCapped,
} from './did-document.js';

/**
 * `SpaceRepoPort` over the Spaces protocol (specs/audio-service-mode.md §4.2,
 * Phase C), checked against the reference implementation at
 * `0.0.0-spaces-alpha-20261029171913` ("Phase C verification").
 *
 * ## The exchange
 *
 * `com.atproto.space.getSpaceCredential` at the authority's `#atproto_pds`,
 * with the tenant's delegation token and `credentialKid`: a P-256 key made
 * here for this credential alone and never exported. The credential is bound
 * to that key, so it's worthless to anyone holding it without the key. It
 * lives about ten minutes; a reader is for one call's work and is dropped
 * with its key.
 *
 * ## Reads
 *
 * Each request goes to the **writer's** PDS and carries the credential, signed
 * (RFC 9421, via `createSpaceSigHeaders`) for the DID it's addressed to, so it
 * can't be replayed against another account. `getRecord` also asks for a
 * record MAC: a fresh key share encapsulated against the writer's
 * `#atproto_kem`, which the host answers with `atproto-space-mac` over the URI
 * and CID. The reference host refuses a credentialed `getRecord` without one
 * (`BadSpaceMac`). `getBlob` serves only blobs a record in that space references.
 *
 * ## Classification
 *
 * As `public-repo.ts`, plus the exchange's two answers about the space:
 * `SpaceDeleted` is `deleted`; `SpaceNotFound` (also a host's answer to a
 * delegation it won't honour) and the token errors are `refused`, never gone.
 * A writer's host that rejects the credential (401) is `unreachable`: it
 * tells us nothing about the record.
 */

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
    'UserNotAuthorized',
    'JwtReplayed',
]);

export type SpaceRepoOptions = DidDocumentResolverOptions;

export function spaceRepo(opts: SpaceRepoOptions = {}): SpaceRepoPort {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const now = opts.now ?? Date.now;
    const docOf = didDocumentResolver(opts);

    return {
        async open(space, delegation): Promise<SpaceOpenResult> {
            const doc = await docOf(space.authority);
            if (!doc.ok) return asOpenFailure(doc, 'authority');
            const host = pdsEndpointOf(doc.value);
            if (!host.ok) return asOpenFailure(host, 'authority');

            const key = await P256Keypair.create();
            const spaceUri = spaceUriOf(space);
            let res: Response;
            try {
                res = await fetchImpl(new URL('/xrpc/com.atproto.space.getSpaceCredential', host.value), {
                    method: 'POST',
                    redirect: 'manual',
                    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
                    headers: { 'content-type': 'application/json', accept: 'application/json' },
                    body: JSON.stringify({
                        space: spaceUri,
                        credentialKid: key.did(),
                        delegationToken: delegation.delegationToken,
                        ...(delegation.clientAttestation ? { clientAttestation: delegation.clientAttestation } : {}),
                    }),
                });
            } catch (err) {
                return { ok: false, kind: 'unreachable', reason: `getSpaceCredential: ${errorText(err)}` };
            }
            const body = (await res.json().catch(() => null)) as { credential?: unknown; error?: unknown } | null;
            if (!res.ok) {
                const name = typeof body?.error === 'string' ? body.error : undefined;
                const reason = `getSpaceCredential: ${res.status}${name ? ` ${name}` : ''}`;
                if (name === 'SpaceDeleted') return { ok: false, kind: 'deleted', reason };
                if (res.status >= 400 && res.status < 500 && name && REFUSED_ERRORS.has(name)) {
                    return { ok: false, kind: 'refused', reason };
                }
                if (res.status >= 500 || res.status === 429) return { ok: false, kind: 'unreachable', reason };
                return { ok: false, kind: 'refused', reason };
            }
            if (typeof body?.credential !== 'string') {
                return { ok: false, kind: 'unreachable', reason: 'getSpaceCredential: the answer carried no credential' };
            }
            return { ok: true, reader: reader(spaceUri, body.credential, key) };
        },
    };

    function reader(spaceUri: string, credential: string, key: P256Keypair): SpaceReader {
        // A signature covers only the credential and its audience, so one per
        // writer serves every request to that writer.
        const signed = new Map<string, Promise<Record<string, string>>>();
        const headersFor = (audience: string) => {
            let headers = signed.get(audience);
            if (!headers) {
                headers = createSpaceSigHeaders(key, {
                    authorization: `Atproto-Space-Credential ${credential}`,
                    audience: audience as `did:${string}:${string}`,
                });
                signed.set(audience, headers);
            }
            return headers;
        };

        /** A writer's PDS and, for a record, its KEM key. */
        async function writer(did: string): Promise<RepoResult<{ pds: string; doc: DidDocument }>> {
            const doc = await docOf(did);
            if (!doc.ok) return doc;
            const pds = pdsEndpointOf(doc.value);
            return pds.ok ? { ok: true, value: { pds: pds.value, doc: doc.value } } : pds;
        }

        return {
            expiresAt: expiryOf(credential, now()),

            async getRecord(ref): Promise<RepoResult<FetchedRecord>> {
                const host = await writer(ref.did);
                if (!host.ok) return host;
                const kem = kemDidKeyOf(host.value.doc);
                if (!kem) return { ok: false, kind: 'invalid', reason: "the writer's DID document has no P-256 #atproto_kem key" };

                const { keyShare, sharedSecret } = await encapsulate(kem);
                const url = new URL('/xrpc/com.atproto.space.getRecord', host.value.pds);
                url.searchParams.set('space', spaceUri);
                url.searchParams.set('repo', ref.did);
                url.searchParams.set('collection', ref.collection);
                url.searchParams.set('rkey', ref.rkey);
                let res: Response;
                try {
                    res = await fetchImpl(url, {
                        redirect: 'manual',
                        signal: AbortSignal.timeout(RECORD_TIMEOUT_MS),
                        headers: { ...(await headersFor(ref.did)), [WANT_MAC_HEADER]: formatWantMacHeader(RECORD_MAC_TYPE, keyShare) },
                    });
                } catch (err) {
                    return { ok: false, kind: 'unreachable', reason: `space getRecord: ${errorText(err)}` };
                }
                if (!res.ok) return failure(res, 'space getRecord');

                const body = (await res.json().catch(() => null)) as { uri?: unknown; cid?: unknown; value?: unknown } | null;
                if (!body || typeof body.cid !== 'string' || body.value === null || typeof body.value !== 'object') {
                    return { ok: false, kind: 'unreachable', reason: 'space getRecord: the answer carried no record and CID' };
                }
                // The MAC is over the URI the host names and the CID it reports,
                // so check the URI is the one asked for, then the MAC.
                const expected = `${spaceUri}/${ref.did}/${ref.collection}/${ref.rkey}`;
                if (body.uri !== expected) {
                    return { ok: false, kind: 'invalid', reason: `space getRecord answered for ${String(body.uri)}, not ${expected}` };
                }
                let macOk: boolean;
                try {
                    const mac = parseMacHeader(res.headers.get(MAC_HEADER) ?? undefined, RECORD_MAC_TYPE);
                    macOk = verifyRecordMac(sharedSecret, expected, CID.parse(body.cid), mac);
                } catch (err) {
                    return { ok: false, kind: 'invalid', reason: `space getRecord: no usable record MAC (${errorText(err)})` };
                }
                if (!macOk) return { ok: false, kind: 'invalid', reason: 'space getRecord: the record MAC did not verify' };
                return { ok: true, value: { cid: body.cid, value: body.value } };
            },

            async getBlob(repoDid, cid, maxBytes): Promise<RepoResult<FetchedBlob>> {
                const host = await writer(repoDid);
                if (!host.ok) return host;
                const url = new URL('/xrpc/com.atproto.space.getBlob', host.value.pds);
                url.searchParams.set('space', spaceUri);
                url.searchParams.set('repo', repoDid);
                url.searchParams.set('cid', cid);
                let res: Response;
                try {
                    res = await fetchImpl(url, {
                        redirect: 'manual',
                        signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
                        headers: await headersFor(repoDid),
                    });
                } catch (err) {
                    return { ok: false, kind: 'unreachable', reason: `space getBlob: ${errorText(err)}` };
                }
                if (!res.ok) return failure(res, 'space getBlob');

                const declared = Number(res.headers.get('content-length'));
                if (Number.isFinite(declared) && declared > maxBytes) {
                    await res.body?.cancel().catch(() => undefined);
                    return { ok: false, kind: 'invalid', reason: `blob is ${declared} bytes, over the ${maxBytes} cap` };
                }
                const bytes = await readCapped(res, maxBytes);
                if (bytes === 'too-large') return { ok: false, kind: 'invalid', reason: `blob is over the ${maxBytes} cap` };
                if (bytes === 'failed') return { ok: false, kind: 'unreachable', reason: 'space getBlob: the body broke off' };
                return { ok: true, value: { bytes, contentType: res.headers.get('content-type') ?? undefined } };
            },
        };
    }
}

/** Classify a non-2xx answer from a writer's host. */
async function failure(res: Response, what: string): Promise<{ ok: false; kind: 'gone' | 'unreachable'; reason: string }> {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const name = typeof body?.error === 'string' ? body.error : undefined;
    if ((res.status === 400 || res.status === 404) && name && GONE_ERRORS.has(name)) {
        return { ok: false, kind: 'gone', reason: `${what}: ${name}` };
    }
    return { ok: false, kind: 'unreachable', reason: `${what}: ${res.status}${name ? ` ${name}` : ''}` };
}

function asOpenFailure(result: Extract<RepoResult<unknown>, { ok: false }>, whose: string): SpaceOpenResult {
    // A DID document that's gone for the authority means its spaces can't be
    // read, not that they were deleted: only `SpaceDeleted` says that.
    const kind = result.kind === 'invalid' ? 'invalid' : 'unreachable';
    return { ok: false, kind, reason: `${whose}: ${result.reason}` };
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
