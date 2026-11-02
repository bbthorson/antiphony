import { describe, it, expect, vi } from 'vitest';
import { publicRepo } from './public-repo.js';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const PDS = 'https://pds.example';
const REF = { did: DID, collection: 'dev.antiphony.audio.post', rkey: '3kremote00001' };

const doc = (endpoint: string = PDS, id: string = DID) => ({
    id,
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: endpoint }],
});

/** A fetch that answers by URL prefix. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
    return vi.fn(async (input: string | URL) => {
        const url = String(input);
        const hit = Object.keys(routes).find((prefix) => url.startsWith(prefix));
        if (!hit) throw new Error(`unexpected fetch ${url}`);
        return routes[hit]();
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PLC = `https://plc.directory/${DID}`;
const GET_RECORD = `${PDS}/xrpc/com.atproto.repo.getRecord`;
const GET_BLOB = `${PDS}/xrpc/com.atproto.sync.getBlob`;

describe('publicRepo', () => {
    it("reads a record from the PDS the DID document names", async () => {
        const fetchImpl = fakeFetch({
            [PLC]: () => json(doc()),
            [GET_RECORD]: () => json({ uri: 'at://x', cid: 'bafyrec', value: { $type: 'dev.antiphony.audio.post' } }),
        });
        const result = await publicRepo({ fetchImpl }).getRecord(REF);
        expect(result).toEqual({ ok: true, value: { cid: 'bafyrec', value: { $type: 'dev.antiphony.audio.post' } } });
        const recordUrl = new URL(String(fetchImpl.mock.calls[1][0]));
        expect(Object.fromEntries(recordUrl.searchParams)).toEqual({
            repo: DID,
            collection: 'dev.antiphony.audio.post',
            rkey: '3kremote00001',
        });
        expect(fetchImpl.mock.calls[1][1]).toMatchObject({ redirect: 'manual' });
    });

    it('resolves the PDS once per isolate, within the cache window', async () => {
        const fetchImpl = fakeFetch({
            [PLC]: () => json(doc()),
            [GET_RECORD]: () => json({ cid: 'bafyrec', value: {} }),
        });
        const repo = publicRepo({ fetchImpl });
        await repo.getRecord(REF);
        await repo.getRecord(REF);
        expect(fetchImpl.mock.calls.filter(([u]) => String(u).startsWith(PLC))).toHaveLength(1);
    });

    it.each([
        ['RecordNotFound', 400, 'gone'],
        ['RepoNotFound', 400, 'gone'],
        ['RepoDeactivated', 400, 'unreachable'],
        ['InternalServerError', 500, 'unreachable'],
    ])('classifies %s (%i) as %s', async (error, status, kind) => {
        const fetchImpl = fakeFetch({ [PLC]: () => json(doc()), [GET_RECORD]: () => json({ error }, status) });
        expect(await publicRepo({ fetchImpl }).getRecord(REF)).toMatchObject({ ok: false, kind });
    });

    it('calls a tombstoned DID gone and a PLC outage unreachable', async () => {
        expect(await publicRepo({ fetchImpl: fakeFetch({ [PLC]: () => json({}, 410) }) }).getRecord(REF)).toMatchObject({
            ok: false,
            kind: 'gone',
        });
        expect(await publicRepo({ fetchImpl: fakeFetch({ [PLC]: () => json({}, 503) }) }).getRecord(REF)).toMatchObject({
            ok: false,
            kind: 'unreachable',
        });
        const thrown = fakeFetch({ [PLC]: () => Promise.reject(new Error('timeout')) });
        expect(await publicRepo({ fetchImpl: thrown }).getRecord(REF)).toMatchObject({ ok: false, kind: 'unreachable' });
    });

    it('refuses a PDS that is not HTTPS, and a document that is not for this DID', async () => {
        expect(
            await publicRepo({ fetchImpl: fakeFetch({ [PLC]: () => json(doc('http://pds.example')) }) }).getRecord(REF),
        ).toMatchObject({ ok: false, kind: 'invalid' });
        expect(
            await publicRepo({ fetchImpl: fakeFetch({ [PLC]: () => json(doc(PDS, 'did:plc:someoneelse')) }) }).getRecord(REF),
        ).toMatchObject({ ok: false, kind: 'unreachable' });
    });

    it('treats a redirect as unreachable rather than following it', async () => {
        const fetchImpl = fakeFetch({
            [PLC]: () => json(doc()),
            [GET_RECORD]: () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
        });
        expect(await publicRepo({ fetchImpl }).getRecord(REF)).toMatchObject({ ok: false, kind: 'unreachable' });
    });

    it('reads a blob within the cap', async () => {
        const fetchImpl = fakeFetch({
            [PLC]: () => json(doc()),
            [GET_BLOB]: () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mp4' } }),
        });
        const result = await publicRepo({ fetchImpl }).getBlob(DID, 'bafkblob', 10);
        expect(result).toEqual({ ok: true, value: { bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/mp4' } });
    });

    it('refuses a blob over the cap, by its declared length or while reading it', async () => {
        const declared = fakeFetch({
            [PLC]: () => json(doc()),
            [GET_BLOB]: () => new Response(new Uint8Array(4), { headers: { 'content-length': '4000' } }),
        });
        expect(await publicRepo({ fetchImpl: declared }).getBlob(DID, 'bafkblob', 10)).toMatchObject({
            ok: false,
            kind: 'invalid',
        });

        const streamed = fakeFetch({
            [PLC]: () => json(doc()),
            [GET_BLOB]: () =>
                new Response(
                    new ReadableStream({
                        start(c) {
                            c.enqueue(new Uint8Array(8));
                            c.enqueue(new Uint8Array(8));
                            c.close();
                        },
                    }),
                ),
        });
        expect(await publicRepo({ fetchImpl: streamed }).getBlob(DID, 'bafkblob', 10)).toMatchObject({
            ok: false,
            kind: 'invalid',
        });
    });

    it('calls a missing blob gone', async () => {
        const fetchImpl = fakeFetch({ [PLC]: () => json(doc()), [GET_BLOB]: () => json({ error: 'BlobNotFound' }, 400) });
        expect(await publicRepo({ fetchImpl }).getBlob(DID, 'bafkblob', 10)).toMatchObject({ ok: false, kind: 'gone' });
    });

    it('resolves did:web through its well-known document', async () => {
        const fetchImpl = fakeFetch({
            'https://group.example/.well-known/did.json': () => json(doc(PDS, 'did:web:group.example')),
            [GET_RECORD]: () => json({ cid: 'bafyrec', value: {} }),
        });
        expect(await publicRepo({ fetchImpl }).getRecord({ ...REF, did: 'did:web:group.example' })).toMatchObject({ ok: true });
    });
});
