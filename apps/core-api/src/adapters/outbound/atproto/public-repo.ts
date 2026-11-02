import type {
    FetchedBlob,
    FetchedRecord,
    PublicRepoPort,
    RepoResult,
} from '@antiphony/core/ports/public-repo';
import { didPlcToUrl, didWebToUrl } from '../../../lib/app-did.js';

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

const DOC_TIMEOUT_MS = 5_000;
const RECORD_TIMEOUT_MS = 10_000;
const BLOB_TIMEOUT_MS = 30_000;
/** How long a resolved PDS endpoint is reused within one isolate. */
const PDS_CACHE_MS = 10 * 60 * 1000;

const GONE_ERRORS = new Set(['RecordNotFound', 'RepoNotFound', 'BlobNotFound']);

export interface PublicRepoOptions {
    fetchImpl?: typeof fetch;
    plcDirectoryUrl?: string;
    now?: () => number;
}

export function publicRepo(opts: PublicRepoOptions = {}): PublicRepoPort {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const now = opts.now ?? Date.now;
    const pdsCache = new Map<string, { endpoint: string; at: number }>();

    async function resolvePds(did: string): Promise<RepoResult<string>> {
        const hit = pdsCache.get(did);
        if (hit && now() - hit.at < PDS_CACHE_MS) return { ok: true, value: hit.endpoint };

        const docUrl = did.startsWith('did:plc:') ? didPlcToUrl(did, opts.plcDirectoryUrl) : didWebToUrl(did);
        if (!docUrl) return { ok: false, kind: 'invalid', reason: `unsupported or malformed DID: ${did}` };

        let res: Response;
        try {
            res = await fetchImpl(docUrl, { redirect: 'manual', signal: AbortSignal.timeout(DOC_TIMEOUT_MS) });
        } catch (err) {
            return { ok: false, kind: 'unreachable', reason: `DID document: ${errorText(err)}` };
        }
        if (res.status === 404 || res.status === 410) {
            return { ok: false, kind: 'gone', reason: `DID document answered ${res.status}` };
        }
        if (!res.ok) return { ok: false, kind: 'unreachable', reason: `DID document answered ${res.status}` };

        const doc = (await res.json().catch(() => null)) as {
            id?: unknown;
            service?: { id?: unknown; serviceEndpoint?: unknown }[];
        } | null;
        if (!doc || doc.id !== did) return { ok: false, kind: 'unreachable', reason: 'DID document is not for this DID' };
        const endpoint = doc.service?.find((s) => typeof s.id === 'string' && s.id.endsWith('#atproto_pds'))?.serviceEndpoint;
        if (typeof endpoint !== 'string') return { ok: false, kind: 'gone', reason: 'DID document names no #atproto_pds' };
        let url: URL;
        try {
            url = new URL(endpoint);
        } catch {
            return { ok: false, kind: 'invalid', reason: 'malformed #atproto_pds endpoint' };
        }
        if (url.protocol !== 'https:') return { ok: false, kind: 'invalid', reason: '#atproto_pds is not HTTPS' };

        const value = url.origin;
        pdsCache.set(did, { endpoint: value, at: now() });
        return { ok: true, value };
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

/** Read a body, giving up as soon as it passes `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | 'too-large' | 'failed'> {
    if (!res.body) return new Uint8Array();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return 'too-large';
            }
            chunks.push(value);
        }
    } catch {
        return 'failed';
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
