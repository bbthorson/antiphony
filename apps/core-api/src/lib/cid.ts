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
