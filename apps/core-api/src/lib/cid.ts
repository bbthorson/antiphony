import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';
import * as dagCbor from '@ipld/dag-cbor';

/**
 * Content-CID computation, following the AT Protocol rules:
 *
 *  - **Blobs**: CIDv1, `raw` codec (0x55), sha2-256 over the bytes. This is
 *    what goes into a blob ref's `ref.$link` and names the storage object
 *    (`blobs/{originAppId}/{cid}`).
 *  - **Records**: CIDv1, `dag-cbor` codec (0x71), sha2-256 over the DAG-CBOR
 *    encoding of the canonical lexicon record. DAG-CBOR's deterministic map
 *    ordering is what makes the CID stable regardless of JS key order.
 *
 * Kept in core-api (not `@antiphony/core`) so core stays dependency-free;
 * the domain service reaches this through the `cidForRecord` port method.
 */

/** CID for raw blob bytes (CIDv1, raw codec, sha2-256). */
export async function cidForBytes(bytes: Uint8Array): Promise<string> {
    const digest = await sha256.digest(bytes);
    return CID.createV1(raw.code, digest).toString();
}

/** CID for a canonical lexicon record (CIDv1, dag-cbor, sha2-256). */
export async function cidForRecord(record: Record<string, unknown>): Promise<string> {
    const bytes = dagCbor.encode(record);
    const digest = await sha256.digest(bytes);
    return CID.createV1(dagCbor.code, digest).toString();
}

/**
 * Convert a record in atproto's JSON form to the IPLD data model its CID is
 * computed over: `{ "$link": "<cid>" }` is a CID link and `{ "$bytes": "<b64>" }`
 * is bytes (the atproto data model's JSON encoding). A blob ref's `ref` is a
 * `$link`, so without this a record fetched from a PDS never hashes to its CID.
 */
export function repoJsonToIpld(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(repoJsonToIpld);
    if (value === null || typeof value !== 'object') return value;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === '$link' && typeof obj.$link === 'string') return CID.parse(obj.$link);
    if (keys.length === 1 && keys[0] === '$bytes' && typeof obj.$bytes === 'string') {
        return Uint8Array.from(atob(obj.$bytes.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = repoJsonToIpld(obj[k]);
    return out;
}

/**
 * CID for a record as a PDS returns it from `com.atproto.repo.getRecord`
 * (CIDv1, dag-cbor, sha2-256 over its IPLD form). Throws on a value that
 * can't be encoded (a float, or a malformed `$link`), which no valid atproto
 * record contains.
 */
export async function cidForRepoRecord(value: unknown): Promise<string> {
    const bytes = dagCbor.encode(repoJsonToIpld(value));
    const digest = await sha256.digest(bytes);
    return CID.createV1(dagCbor.code, digest).toString();
}
