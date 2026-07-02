import { describe, it, expect } from 'vitest';
import { cidForBytes, cidForRecord } from './cid.js';

describe('cidForBytes (blob CIDs)', () => {
    it('produces a CIDv1 raw+sha256 (base32 "bafkrei..." prefix), deterministically', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const cid = await cidForBytes(bytes);
        expect(cid).toMatch(/^bafkrei[a-z2-7]+$/);
        expect(await cidForBytes(new Uint8Array([1, 2, 3, 4]))).toBe(cid);
    });

    it('changes when the content changes', async () => {
        expect(await cidForBytes(new Uint8Array([1]))).not.toBe(await cidForBytes(new Uint8Array([2])));
    });
});

describe('cidForRecord (record CIDs)', () => {
    it('produces a CIDv1 dag-cbor+sha256 (base32 "bafyrei..." prefix)', async () => {
        const cid = await cidForRecord({ $type: 'dev.antiphony.audio.post', text: 'hi', createdAt: '2026-01-01T00:00:00.000Z' });
        expect(cid).toMatch(/^bafyrei[a-z2-7]+$/);
    });

    it('is independent of JS object key order (DAG-CBOR canonical map ordering)', async () => {
        const a = await cidForRecord({ text: 'hi', $type: 'dev.antiphony.audio.post', createdAt: 'x' });
        const b = await cidForRecord({ createdAt: 'x', $type: 'dev.antiphony.audio.post', text: 'hi' });
        expect(a).toBe(b);
    });

    it('changes when any field changes — including key PRESENCE', async () => {
        const base = { $type: 't', text: 'hi' };
        expect(await cidForRecord(base)).not.toBe(await cidForRecord({ ...base, text: 'hi!' }));
        // An `undefined`-valued key must not be passed (DAG-CBOR rejects it);
        // canonicalPostRecord omits absent optionals for exactly this reason.
        expect(await cidForRecord(base)).not.toBe(await cidForRecord({ ...base, title: 'x' }));
    });
});
