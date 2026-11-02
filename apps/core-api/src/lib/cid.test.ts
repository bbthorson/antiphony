import { describe, it, expect } from 'vitest';
import { cidForBytes, cidForRecord, cidForRepoRecord } from './cid.js';

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

/**
 * Bluesky's data-model interop vectors (bluesky-social/atproto-interop-tests,
 * data-model/data-model-fixtures.json at 056e574): a record in atproto's JSON
 * form, with `$link`, unpadded `$bytes` and a blob ref, and the CID a PDS
 * computes for it. A remote post is accepted only if its record hashes to the
 * CID its repo reports, so this is the check that makes that comparison sound.
 */
describe('cidForRepoRecord (records as a PDS returns them)', () => {
    const LINK = 'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a';

    it.each([
        [
            'links, bytes and a blob ref',
            {
                a: { $link: LINK },
                b: { $bytes: 'nFERjvLLiw9qm45JrqH9QTzyC2Lu1Xb4ne6+sBrCzI0' },
                c: {
                    $type: 'blob',
                    ref: { $link: 'bafkreiccldh766hwcnuxnf2wh6jgzepf2nlu2lvcllt63eww5p6chi4ity' },
                    mimeType: 'image/jpeg',
                    size: 10000,
                },
            },
            'bafyreihldkhcwijkde7gx4rpkkuw7pl6lbyu5gieunyc7ihactn5bkd2nm',
        ],
        [
            'nested arrays of links and bytes',
            {
                a: {
                    b: [
                        {
                            d: [{ $link: LINK }, { $link: LINK }],
                            e: [
                                { $bytes: 'nFERjvLLiw9qm45JrqH9QTzyC2Lu1Xb4ne6+sBrCzI0' },
                                { $bytes: 'iE+sPoHobU9tSIqGI+309LLCcWQIRmEXwxcoDt19tas' },
                            ],
                        },
                    ],
                },
            },
            'bafyreid3imdulnhgeytpf6uk7zahjvrsqlofkmm5b5ub2maw4kqus6jp4i',
        ],
    ])('matches the interop vector: %s', async (_label, json, cid) => {
        expect(await cidForRepoRecord(json)).toBe(cid);
    });

    it('differs from cidForRecord, which encodes a $link as a plain map', async () => {
        const record = { ref: { $link: LINK } };
        expect(await cidForRepoRecord(record)).not.toBe(await cidForRecord(record));
    });
});
