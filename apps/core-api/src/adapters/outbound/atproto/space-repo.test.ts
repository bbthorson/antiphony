import { describe, it, expect, beforeEach } from 'vitest';
import { P256Keypair, bytesToMultibase, parseDidKey } from '@atproto/crypto';
import {
    RECORD_MAC_TYPE,
    WANT_MAC_HEADER,
    MAC_HEADER,
    computeRecordMac,
    createSpaceToken,
    decapsulate,
    formatMacHeader,
    parseSpaceToken,
    parseWantMacHeader,
    verifyCredentialSig,
} from '@atproto/space';
import { CID } from 'multiformats/cid';
import { spaceRepo } from './space-repo.js';
import { kemDidKeyOf } from './did-document.js';

/**
 * `spaceRepo` against a fake group host and a fake writer host, both built
 * from `@atproto/space`'s own primitives: the authority mints a real
 * credential bound to the key the adapter names, and the writer's host
 * verifies the request signature against it and answers with a real record
 * MAC. What these hosts do on the wire was checked against the reference
 * implementation (specs/audio-service-mode.md, "Phase C verification").
 */

const GROUP = 'did:plc:groupaaaaaaaaaaaaaaaaaaa';
const PLAYER = 'did:plc:playeraaaaaaaaaaaaaaaaaa';
const SPACE = { authority: GROUP, type: 'game.bardcast.space.campaign', skey: 'thornwood' };
const SPACE_URI = `at://${GROUP}/space/${SPACE.type}/${SPACE.skey}`;
const REF = { did: PLAYER, collection: 'dev.antiphony.audio.post', rkey: '3kspace000001' };
const RECORD_URI = `${SPACE_URI}/${PLAYER}/${REF.collection}/${REF.rkey}`;
const RECORD_CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm';
const BLOB = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 9, 9]);

type Host = {
    authority: P256Keypair;
    writerKem: P256Keypair;
    /** How the authority answers the exchange: a credential, or an XRPC error. */
    exchange: { status: number; error: string } | 'ok';
    /** What the writer's host does with a record request. */
    record: 'ok' | 'gone' | 'no-mac' | 'bad-mac' | 'other-uri';
    kemForm: 'legacy' | 'multikey' | 'none';
    /** The key the last credential was bound to, and every request's audience. */
    boundKey?: string;
    audiences: string[];
    exchanges: Record<string, unknown>[];
};

function hostFetch(host: Host): typeof fetch {
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const headers = Object.fromEntries(new Headers(init?.headers).entries());

        if (url.hostname === 'plc.directory') {
            const did = decodeURIComponent(url.pathname.slice(1));
            if (did === GROUP) {
                return json(200, { id: GROUP, service: [{ id: '#atproto_pds', serviceEndpoint: 'https://group-host.example' }] });
            }
            if (did === PLAYER) {
                const kemDid = host.writerKem.did();
                const method =
                    host.kemForm === 'none'
                        ? []
                        : host.kemForm === 'multikey'
                          ? [{ id: '#atproto_kem', type: 'Multikey', publicKeyMultibase: kemDid.slice('did:key:'.length) }]
                          : [
                                {
                                    id: '#atproto_kem',
                                    type: 'EcdsaSecp256r1VerificationKey2019',
                                    publicKeyMultibase: bytesToMultibase(parseDidKey(kemDid).keyBytes, 'base58btc'),
                                },
                            ];
                return json(200, {
                    id: PLAYER,
                    service: [{ id: '#atproto_pds', serviceEndpoint: 'https://player-pds.example' }],
                    verificationMethod: method,
                });
            }
            return json(404, {});
        }

        if (url.href.startsWith('https://group-host.example/xrpc/com.atproto.space.getSpaceCredential')) {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            host.exchanges.push(body);
            if (host.exchange !== 'ok') return json(host.exchange.status, { error: host.exchange.error });
            host.boundKey = body.credentialKid as string;
            const credential = await createSpaceToken(
                'credential',
                { iss: GROUP, sub: String(body.space), keyId: body.credentialKid as `did:key:${string}` },
                host.authority,
            );
            return json(200, { credential });
        }

        if (url.hostname === 'player-pds.example') {
            // The writer's host: the credential's signature, for this audience.
            await verifyCredentialSig(headers, host.boundKey as `did:key:${string}`);
            const audience = headers['atproto-space-audience'];
            host.audiences.push(audience);
            if (audience !== url.searchParams.get('repo')) return json(401, { error: 'BadSpaceAudience' });
            const token = headers.authorization.replace(/^Atproto-Space-Credential /, '');
            if (parseSpaceToken('credential', token).payload.sub !== url.searchParams.get('space')) {
                return json(401, { error: 'BadJwtSub' });
            }

            if (url.pathname === '/xrpc/com.atproto.space.getRecord') {
                if (host.record === 'gone') return json(400, { error: 'RecordNotFound' });
                const want = headers[WANT_MAC_HEADER];
                if (!want) return json(400, { error: 'BadSpaceMac' });
                const secret = decapsulate(host.writerKem, parseWantMacHeader(want, RECORD_MAC_TYPE));
                const uri = host.record === 'other-uri' ? RECORD_URI.replace('3kspace000001', '3kother') : RECORD_URI;
                const mac = computeRecordMac(host.record === 'bad-mac' ? new Uint8Array(32) : secret, uri, CID.parse(RECORD_CID));
                return json(
                    200,
                    { uri, cid: RECORD_CID, value: { $type: 'dev.antiphony.audio.post', text: 'hi' } },
                    host.record === 'no-mac' ? {} : { [MAC_HEADER]: formatMacHeader(RECORD_MAC_TYPE, mac) },
                );
            }
            if (url.pathname === '/xrpc/com.atproto.space.getBlob') {
                if (url.searchParams.get('cid') !== 'bafkreiblob') return json(400, { error: 'BlobNotFound' });
                return new Response(BLOB, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(BLOB.length) } });
            }
        }
        return json(500, { error: 'Unexpected' });
    }) as typeof fetch;
}

describe('spaceRepo', () => {
    let host: Host;
    beforeEach(async () => {
        host = {
            authority: await P256Keypair.create(),
            writerKem: await P256Keypair.create({ exportable: true }),
            exchange: 'ok',
            record: 'ok',
            kemForm: 'legacy',
            audiences: [],
            exchanges: [],
        };
    });
    const port = () => spaceRepo({ fetchImpl: hostFetch(host), plcDirectoryUrl: 'https://plc.directory' });
    const open = async () => {
        const opened = await port().open(SPACE, { delegationToken: 'delegation.jwt.token' });
        if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
        return opened.reader;
    };

    it('exchanges the delegation for a credential bound to a key it made, at the authority', async () => {
        const reader = await open();
        expect(host.exchanges).toEqual([{ space: SPACE_URI, credentialKid: host.boundKey, delegationToken: 'delegation.jwt.token' }]);
        expect(host.boundKey).toMatch(/^did:key:zDn/);
        // The reference credential lives ten minutes.
        expect(reader.expiresAt - Date.now()).toBeGreaterThan(9 * 60 * 1000);
        expect(reader.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    });

    it('sends a client attestation when there is one', async () => {
        await port().open(SPACE, { delegationToken: 'd.j.t', clientAttestation: 'a.j.t' });
        expect(host.exchanges[0]).toMatchObject({ clientAttestation: 'a.j.t' });
    });

    it("reads a record from the writer's host, signed for the writer, with a verified MAC", async () => {
        const got = await (await open()).getRecord(REF);
        expect(got).toEqual({ ok: true, value: { cid: RECORD_CID, value: { $type: 'dev.antiphony.audio.post', text: 'hi' } } });
        expect(host.audiences).toEqual([PLAYER]);
    });

    it('reads a KEM key published as a Multikey too', async () => {
        host.kemForm = 'multikey';
        expect((await (await open()).getRecord(REF)).ok).toBe(true);
    });

    it.each([
        ['no MAC', 'no-mac'],
        ['a MAC that does not verify', 'bad-mac'],
        ['a record at another URI', 'other-uri'],
    ] as const)('refuses an answer with %s as invalid', async (_label, record) => {
        host.record = record;
        expect(await (await open()).getRecord(REF)).toMatchObject({ ok: false, kind: 'invalid' });
    });

    it('needs the writer to publish a KEM key', async () => {
        host.kemForm = 'none';
        expect(await (await open()).getRecord(REF)).toMatchObject({ ok: false, kind: 'invalid' });
    });

    it('reads RecordNotFound as gone', async () => {
        host.record = 'gone';
        expect(await (await open()).getRecord(REF)).toMatchObject({ ok: false, kind: 'gone' });
    });

    it("reads a blob from the writer's host, capped", async () => {
        const reader = await open();
        expect(await reader.getBlob(PLAYER, 'bafkreiblob', 1024)).toMatchObject({ ok: true, value: { bytes: BLOB } });
        expect(await reader.getBlob(PLAYER, 'bafkreiblob', 4)).toMatchObject({ ok: false, kind: 'invalid' });
        expect(await reader.getBlob(PLAYER, 'bafkreiother', 1024)).toMatchObject({ ok: false, kind: 'gone' });
    });

    it.each([
        [{ status: 400, error: 'SpaceDeleted' }, 'deleted'],
        [{ status: 400, error: 'SpaceNotFound' }, 'refused'],
        [{ status: 400, error: 'InvalidDelegationToken' }, 'refused'],
        [{ status: 400, error: 'AppNotAuthorized' }, 'refused'],
        [{ status: 502, error: 'UpstreamFailure' }, 'unreachable'],
    ] as const)('classifies an exchange answering %o as %s', async (answer, kind) => {
        host.exchange = answer;
        expect(await port().open(SPACE, { delegationToken: 'd.j.t' })).toMatchObject({ ok: false, kind });
    });

    it("can't open a space whose authority has no DID document, without calling it deleted", async () => {
        const opened = await port().open({ ...SPACE, authority: 'did:plc:nobodyaaaaaaaaaaaaaaaaaa' }, { delegationToken: 'd.j.t' });
        expect(opened).toMatchObject({ ok: false, kind: 'unreachable' });
    });
});

describe('kemDidKeyOf', () => {
    it('reads the legacy and Multikey spellings to the same did:key, and nothing else', async () => {
        const key = await P256Keypair.create();
        const did = key.did();
        const legacy = { verificationMethod: [{ id: '#atproto_kem', type: 'EcdsaSecp256r1VerificationKey2019', publicKeyMultibase: bytesToMultibase(parseDidKey(did).keyBytes, 'base58btc') }] };
        const multikey = { verificationMethod: [{ id: '#atproto_kem', type: 'Multikey', publicKeyMultibase: did.slice('did:key:'.length) }] };
        expect(kemDidKeyOf(legacy)).toBe(did);
        expect(kemDidKeyOf(multikey)).toBe(did);
        expect(kemDidKeyOf({ verificationMethod: [{ id: '#atproto', type: 'Multikey', publicKeyMultibase: did.slice(8) }] })).toBeNull();
        expect(kemDidKeyOf({ verificationMethod: [{ id: '#atproto_kem', type: 'Multikey', publicKeyMultibase: 'zgarbage' }] })).toBeNull();
    });
});
