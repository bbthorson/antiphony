import type {
    FetchedBlob,
    FetchedRecord,
    PublicRepoPort,
    RepoResult,
} from '@antiphony/core/ports/public-repo';
import { didDocumentResolver, errorText, pdsEndpointOf, readCapped } from './did-document.js';

/**
 * `PublicRepoPort` over plain HTTPS (specs/audio-service-mode.md §4.1): resolve
 * the DID to its `#atproto_pds`, then `com.atproto.repo.getRecord` and
 * `com.atproto.sync.getBlob` there. No atproto client library: each is one GET.
 *
 * ## Guards
 *
 * Every host here comes from a DID document someone else controls, so:
 *  - **HTTPS only**, for the DID document and the PDS endpoint alike;
 *  - **no redirects** (`redirect: 'manual'`): a redirect could point the fetch
 *    anywhere, and a PDS that answers with one is treated as unreachable;
 *  - **timeouts** on every request, and a **byte cap** on the blob, enforced
 *    while reading so an oversized body is never held in full.
 *
 * ## Gone vs unreachable
 *
 * `gone` only when something answered about the thing itself: the PLC
 * directory's 404/410, a `did:web` document's 404/410, or the PDS's
 * `RecordNotFound` / `RepoNotFound` / `BlobNotFound`. Everything else (5xx,
 * timeouts, network errors, a 2xx body that isn't what was asked for, a
 * deactivated repo) is `unreachable`, because the sweep deletes on `gone`.
 */

const RECORD_TIMEOUT_MS = 10_000;
const BLOB_TIMEOUT_MS = 30_000;

const GONE_ERRORS = new Set(['RecordNotFound', 'RepoNotFound', 'BlobNotFound']);

export interface PublicRepoOptions {
    fetchImpl?: typeof fetch;
    plcDirectoryUrl?: string;
    now?: () => number;
}

export function publicRepo(opts: PublicRepoOptions = {}): PublicRepoPort {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const resolveDoc = didDocumentResolver(opts);

    async function resolvePds(did: string): Promise<RepoResult<string>> {
        const doc = await resolveDoc(did);
        return doc.ok ? pdsEndpointOf(doc.value) : doc;
    }

    /** Classify a non-2xx XRPC answer by its status and error name. */
    async function failure(res: Response, what: string): Promise<{ ok: false; kind: 'gone' | 'unreachable'; reason: string }> {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        const name = typeof body?.error === 'string' ? body.error : undefined;
        if ((res.status === 400 || res.status === 404) && name && GONE_ERRORS.has(name)) {
            return { ok: false, kind: 'gone', reason: `${what}: ${name}` };
        }
        return { ok: false, kind: 'unreachable', reason: `${what}: ${res.status}${name ? ` ${name}` : ''}` };
    }

    return {
        async getRecord(ref): Promise<RepoResult<FetchedRecord>> {
            const pds = await resolvePds(ref.did);
            if (!pds.ok) return pds;
            const url = new URL('/xrpc/com.atproto.repo.getRecord', pds.value);
            url.searchParams.set('repo', ref.did);
            url.searchParams.set('collection', ref.collection);
            url.searchParams.set('rkey', ref.rkey);

            let res: Response;
            try {
                res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(RECORD_TIMEOUT_MS) });
            } catch (err) {
                return { ok: false, kind: 'unreachable', reason: `getRecord: ${errorText(err)}` };
            }
            if (!res.ok) return failure(res, 'getRecord');

            const body = (await res.json().catch(() => null)) as { uri?: unknown; cid?: unknown; value?: unknown } | null;
            if (!body || typeof body.cid !== 'string' || body.value === null || typeof body.value !== 'object') {
                return { ok: false, kind: 'unreachable', reason: 'getRecord: the answer carried no record and CID' };
            }
            return { ok: true, value: { cid: body.cid, value: body.value } };
        },

        async getBlob(did, cid, maxBytes): Promise<RepoResult<FetchedBlob>> {
            const pds = await resolvePds(did);
            if (!pds.ok) return pds;
            const url = new URL('/xrpc/com.atproto.sync.getBlob', pds.value);
            url.searchParams.set('did', did);
            url.searchParams.set('cid', cid);

            let res: Response;
            try {
                res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(BLOB_TIMEOUT_MS) });
            } catch (err) {
                return { ok: false, kind: 'unreachable', reason: `getBlob: ${errorText(err)}` };
            }
            if (!res.ok) return failure(res, 'getBlob');

            const declared = Number(res.headers.get('content-length'));
            if (Number.isFinite(declared) && declared > maxBytes) {
                await res.body?.cancel().catch(() => undefined);
                return { ok: false, kind: 'invalid', reason: `blob is ${declared} bytes, over the ${maxBytes} cap` };
            }
            const bytes = await readCapped(res, maxBytes);
            if (bytes === 'too-large') return { ok: false, kind: 'invalid', reason: `blob is over the ${maxBytes} cap` };
            if (bytes === 'failed') return { ok: false, kind: 'unreachable', reason: 'getBlob: the body broke off' };
            return { ok: true, value: { bytes, contentType: res.headers.get('content-type') ?? undefined } };
        },
    };
}
