import { P256_JWT_ALG, formatDidKey, multibaseToBytes, parseMultikey } from '@atproto/crypto';
import type { RepoResult } from '@antiphony/core/ports/public-repo';
import { didPlcToUrl, didWebToUrl } from '../../../lib/app-did.js';

/**
 * Reading the DID documents a remote record's hosts are found through, with
 * the guards `public-repo.ts` explains: HTTPS only, no redirects, timeouts.
 * Shared by the public-repo and space adapters, so both classify a document
 * the same way (`gone` only for the directory's own 404/410).
 */

const DOC_TIMEOUT_MS = 5_000;
/** How long a resolved document is reused within one isolate. */
const DOC_CACHE_MS = 10 * 60 * 1000;

export interface DidDocument {
    id?: unknown;
    service?: { id?: unknown; type?: unknown; serviceEndpoint?: unknown }[];
    verificationMethod?: { id?: unknown; type?: unknown; publicKeyMultibase?: unknown }[];
}

export interface DidDocumentResolverOptions {
    fetchImpl?: typeof fetch;
    plcDirectoryUrl?: string;
    now?: () => number;
}

/** A resolver with its own cache, for one adapter's lifetime. */
export function didDocumentResolver(opts: DidDocumentResolverOptions = {}): (did: string) => Promise<RepoResult<DidDocument>> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const now = opts.now ?? Date.now;
    const cache = new Map<string, { doc: DidDocument; at: number }>();

    return async (did) => {
        const hit = cache.get(did);
        if (hit && now() - hit.at < DOC_CACHE_MS) return { ok: true, value: hit.doc };

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

        const doc = (await res.json().catch(() => null)) as DidDocument | null;
        if (!doc || doc.id !== did) return { ok: false, kind: 'unreachable', reason: 'DID document is not for this DID' };
        cache.set(did, { doc, at: now() });
        return { ok: true, value: doc };
    };
}

/** The document's `#atproto_pds` origin, which must be HTTPS. */
export function pdsEndpointOf(doc: DidDocument): RepoResult<string> {
    const endpoint = doc.service?.find((s) => typeof s.id === 'string' && s.id.endsWith('#atproto_pds'))?.serviceEndpoint;
    if (typeof endpoint !== 'string') return { ok: false, kind: 'gone', reason: 'DID document names no #atproto_pds' };
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        return { ok: false, kind: 'invalid', reason: 'malformed #atproto_pds endpoint' };
    }
    if (url.protocol !== 'https:') return { ok: false, kind: 'invalid', reason: '#atproto_pds is not HTTPS' };
    return { ok: true, value: url.origin };
}

/**
 * The document's `#atproto_kem` key as a P-256 `did:key`: what a space reader
 * encapsulates a request's key share against, so only the writer's host can
 * answer it with a record MAC.
 *
 * Two spellings exist. PLC publishes the legacy
 * `EcdsaSecp256r1VerificationKey2019`, whose multibase is the bare key, so
 * prefixing it with `did:key:` gives a key nobody can parse. A `Multikey`
 * carries its multicodec. Both are read, as `@atproto/identity` does.
 */
export function kemDidKeyOf(doc: DidDocument): string | null {
    const method = doc.verificationMethod?.find((m) => typeof m.id === 'string' && m.id.endsWith('#atproto_kem'));
    if (!method || typeof method.publicKeyMultibase !== 'string') return null;
    try {
        if (method.type === 'EcdsaSecp256r1VerificationKey2019') {
            return formatDidKey(P256_JWT_ALG, multibaseToBytes(method.publicKeyMultibase));
        }
        if (method.type === 'Multikey') {
            const parsed = parseMultikey(method.publicKeyMultibase);
            return parsed.jwtAlg === P256_JWT_ALG ? formatDidKey(parsed.jwtAlg, parsed.keyBytes) : null;
        }
    } catch {
        return null;
    }
    return null;
}

/** Read a body, giving up as soon as it passes `maxBytes`. */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | 'too-large' | 'failed'> {
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

export function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
