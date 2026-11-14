import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { P256Keypair, bytesToMultibase, parseDidKey } from '@atproto/crypto';
import {
    RECORD_MAC_PROFILE,
    createRecordMacHeaders,
    createSpaceCredential,
    decapsulate,
    parseMacRequest,
    parseSpaceToken,
    verifyCredentialSig,
} from '@atproto/space';
import type { AtUriString, DidString, SpaceRefString } from '@atproto/syntax';
import { CID } from 'multiformats/cid';
import { cidForBytes, cidForRepoRecord } from '../../../lib/cid.js';
import { spaceRepo } from './space-repo.js';

/**
 * `spaceRepo` (over `@atproto/lex-space`) against a fake group host and a fake
 * writer host, both built from `@atproto/space`'s own primitives: the authority
 * mints a real credential bound to the key the library names, and the writer's
 * host verifies the request signature against it and answers with a real
 * record MAC. The same adapter also runs against the reference PDS in
 * `space-repo.conformance.test.ts`.
 */

const GROUP = 'did:plc:groupaaaaaaaaaaaaaaaaaaa';
const PLAYER = 'did:plc:playeraaaaaaaaaaaaaaaaaa';
const SPACE = { authority: GROUP, type: 'game.bardcast.space.campaign', skey: 'thornwood' };
const SPACE_URI = `at://${GROUP}/space/${SPACE.type}/${SPACE.skey}`;
const REF = { did: PLAYER, collection: 'dev.antiphony.audio.post', rkey: '3kspace000001' };
const RECORD_URI = `${SPACE_URI}/${PLAYER}/${REF.collection}/${REF.rkey}`;
const BLOB = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 9, 9]);

let BLOB_CID: string;
let RECORD: Record<string, unknown>;
let RECORD_CID: string;

beforeAll(async () => {
    BLOB_CID = await cidForBytes(BLOB);
    RECORD = {
        $type: 'dev.antiphony.audio.post',
        text: 'hi',
        createdAt: '2026-11-14T00:00:00.000Z',
        embed: {
            $type: 'dev.antiphony.embed.audio',
            audio: { $type: 'blob', ref: { $link: BLOB_CID }, mimeType: 'audio/mp4', size: BLOB.length },
        },
    };
    RECORD_CID = await cidForRepoRecord(RECORD);
});

type Host = {
    authority: P256Keypair;
    writerKem: P256Keypair;
    groupEndpoint: string;
    /** How the authority answers the exchange: a credential, an XRPC error, or a redirect. */
    exchange: { status: number; error: string } | 'ok' | 'redirect';
    /** What the writer's host does with a record request. */
    record: 'ok' | 'gone' | 'no-mac' | 'bad-mac' | 'other-uri' | 'tampered' | 'reject-credential';
    /** What the writer's host does with a blob request. */
    blob: 'ok' | 'wrong-bytes' | 'undeclared-length';
    kemForm: 'legacy' | 'multikey' | 'none';
    playerDoc: 'ok' | 'gone';
    /** The key the last credential was bound to, and every request's audience. */
    boundKey?: string;
    audiences: string[];
    exchanges: Record<string, unknown>[];
    requests: { url: string; redirect: RequestRedirect }[];
};

function hostFetch(host: Host): typeof fetch {
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

    return (async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        const headers = Object.fromEntries(req.headers.entries());
        host.requests.push({ url: url.href, redirect: init?.redirect ?? req.redirect });

        if (url.hostname === 'plc.directory') {
            const did = decodeURIComponent(url.pathname.slice(1));
            if (did === GROUP) {
                return json(200, {
                    id: GROUP,
                    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: host.groupEndpoint }],
                });
            }
            if (did === PLAYER && host.playerDoc === 'ok') {
                const kemDid = host.writerKem.did();
                const method =
                    host.kemForm === 'none'
                        ? []
                        : host.kemForm === 'multikey'
                          ? [{ id: '#atproto_kem', type: 'Multikey', controller: PLAYER, publicKeyMultibase: kemDid.slice('did:key:'.length) }]
                          : [
                                {
                                    id: '#atproto_kem',
                                    type: 'EcdsaSecp256r1VerificationKey2019',
                                    controller: PLAYER,
                                    publicKeyMultibase: bytesToMultibase(parseDidKey(kemDid).keyBytes, 'base58btc'),
                                },
                            ];
                return json(200, {
                    id: PLAYER,
                    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://player-pds.example' }],
                    verificationMethod: method,
                });
            }
            return json(404, { message: 'DID not registered' });
        }

        if (url.href.startsWith('https://group-host.example/xrpc/com.atproto.space.authorizeSpaceSync')) {
            if (host.exchange === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } });
            const body = JSON.parse(await req.text()) as Record<string, unknown>;
            host.exchanges.push(body);
            if (host.exchange !== 'ok') return json(host.exchange.status, { error: host.exchange.error });
            host.boundKey = body.credentialKey as string;
            const credential = await createSpaceCredential({
                iss: GROUP,
                sub: String(body.space) as SpaceRefString,
                keyId: body.credentialKey as DidString,
                keypair: host.authority,
            });
            return json(200, { credential });
        }

        if (url.hostname === 'player-pds.example') {
            // The writer's host: the credential's signature, for this audience.
            await verifyCredentialSig(headers, host.boundKey as DidString);
            const audience = headers['atproto-space-audience'];
            host.audiences.push(audience);
            if (audience !== url.searchParams.get('repo')) return json(401, { error: 'BadSpaceAudience' });
            const token = headers.authorization.replace(/^Atproto-Space-Credential /, '');
            if (parseSpaceToken('credential', token).payload.sub !== url.searchParams.get('space')) {
                return json(401, { error: 'BadJwtSub' });
            }

            if (url.pathname === '/xrpc/com.atproto.space.getRecord') {
                if (host.record === 'gone') return json(400, { error: 'RecordNotFound' });
                if (host.record === 'reject-credential') return json(401, { error: 'InvalidToken' });
                const request = parseMacRequest(headers['accept-signature'], RECORD_MAC_PROFILE);
                if (!request) return json(400, { error: 'InvalidSpaceMac' });
                const secret = decapsulate(host.writerKem, request.keyShare);
                const uri = host.record === 'other-uri' ? RECORD_URI.replace('3kspace000001', '3kother') : RECORD_URI;
                const mac = createRecordMacHeaders(uri as AtUriString, CID.parse(RECORD_CID), {
                    ...request,
                    sharedSecret: host.record === 'bad-mac' ? new Uint8Array(32) : secret,
                });
                const value = host.record === 'tampered' ? { ...RECORD, text: 'not what was hashed' } : RECORD;
                return json(200, { uri, cid: RECORD_CID, value }, host.record === 'no-mac' ? {} : mac.headers);
            }
            if (url.pathname === '/xrpc/com.atproto.space.getBlob') {
                if (url.searchParams.get('cid') !== BLOB_CID) return json(400, { error: 'BlobNotFound' });
                const bytes = host.blob === 'wrong-bytes' ? new Uint8Array(BLOB).fill(1) : BLOB;
                const lengthHeader: Record<string, string> = host.blob === 'undeclared-length' ? {} : { 'content-length': String(bytes.length) };
                return new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4', ...lengthHeader } });
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
            groupEndpoint: 'https://group-host.example',
            exchange: 'ok',
            record: 'ok',
            blob: 'ok',
            kemForm: 'legacy',
            playerDoc: 'ok',
            audiences: [],
            exchanges: [],
            requests: [],
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
        expect(host.exchanges).toEqual([{ space: SPACE_URI, credentialKey: host.boundKey, delegationToken: 'delegation.jwt.token' }]);
        expect(host.boundKey).toMatch(/^did:key:zDn/);
        // The reference credential lives ten minutes.
        expect(reader.expiresAt - Date.now()).toBeGreaterThan(9 * 60 * 1000);
        expect(reader.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    });

    it('sends a client attestation when there is one', async () => {
        await port().open(SPACE, { delegationToken: 'd.j.t', clientAttestation: 'a.j.t' });
        expect(host.exchanges[0]).toMatchObject({ clientAttestation: 'a.j.t' });
    });

    it("reads a record from the writer's host, signed for the writer, MAC and CID verified, as JSON", async () => {
        const got = await (await open()).getRecord(REF);
        expect(got).toEqual({ ok: true, value: { cid: RECORD_CID, value: RECORD } });
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
        ['a record that does not hash to its CID', 'tampered'],
    ] as const)('refuses an answer with %s as invalid', async (_label, record) => {
        host.record = record;
        expect(await (await open()).getRecord(REF)).toMatchObject({ ok: false, kind: 'invalid' });
    });

    it('needs the writer to publish a KEM key', async () => {
        host.kemForm = 'none';
        expect(await (await open()).getRecord(REF)).toMatchObject({ ok: false, kind: 'invalid', reason: expect.stringContaining('#atproto_kem') });
    });

    it('reads RecordNotFound as gone', async () => {
        host.record = 'gone';
        expect(await (await open()).getRecord(REF)).toMatchObject({ ok: false, kind: 'gone' });
    });

    it("reads a writer whose DID document is gone as gone", async () => {
        const reader = await open();
        host.playerDoc = 'gone';
        expect(await reader.getRecord(REF)).toMatchObject({ ok: false, kind: 'gone' });
    });

    it("spends the delegation once: a writer that rejects the credential is unreachable", async () => {
        host.record = 'reject-credential';
        expect(await (await open()).getRecord(REF)).toMatchObject({ ok: false, kind: 'unreachable', reason: expect.stringContaining('spent') });
        expect(host.exchanges).toHaveLength(1);
    });

    it("reads a blob from the writer's host, verified against its CID", async () => {
        const reader = await open();
        expect(await reader.getBlob(PLAYER, BLOB_CID, 1024)).toMatchObject({ ok: true, value: { bytes: BLOB, contentType: 'video/mp4' } });
        host.blob = 'wrong-bytes';
        expect(await reader.getBlob(PLAYER, BLOB_CID, 1024)).toMatchObject({ ok: false, kind: 'invalid' });
    });

    it('caps a blob, whether or not the host declares its length', async () => {
        const reader = await open();
        expect(await reader.getBlob(PLAYER, BLOB_CID, 4)).toMatchObject({ ok: false, kind: 'invalid', reason: expect.stringContaining('cap') });
        host.blob = 'undeclared-length';
        expect(await reader.getBlob(PLAYER, BLOB_CID, 4)).toMatchObject({ ok: false, kind: 'invalid', reason: expect.stringContaining('cap') });
        expect(await reader.getBlob(PLAYER, BLOB_CID, 1024)).toMatchObject({ ok: true });
    });

    it('reads BlobNotFound as gone', async () => {
        const reader = await open();
        const other = await cidForBytes(new Uint8Array([1, 2, 3]));
        expect(await reader.getBlob(PLAYER, other, 1024)).toMatchObject({ ok: false, kind: 'gone' });
    });

    it.each([
        [{ status: 400, error: 'SpaceDeleted' }, 'deleted'],
        [{ status: 400, error: 'SpaceNotFound' }, 'refused'],
        [{ status: 400, error: 'InvalidDelegationToken' }, 'refused'],
        [{ status: 400, error: 'AppNotAuthorized' }, 'refused'],
        [{ status: 400, error: 'AccountNotAuthorized' }, 'refused'],
        [{ status: 502, error: 'UpstreamFailure' }, 'unreachable'],
        [{ status: 400, error: 'UpstreamFailure' }, 'unreachable'],
        [{ status: 400, error: 'RepoTakendown' }, 'unreachable'],
    ] as const)('classifies an exchange answering %o as %s', async (answer, kind) => {
        host.exchange = answer;
        expect(await port().open(SPACE, { delegationToken: 'd.j.t' })).toMatchObject({ ok: false, kind });
    });

    it('follows no redirects, and every request says so', async () => {
        host.exchange = 'redirect';
        expect(await port().open(SPACE, { delegationToken: 'd.j.t' })).toMatchObject({ ok: false, kind: 'unreachable', reason: expect.stringContaining('redirect') });
        expect(host.requests.length).toBeGreaterThan(0);
        expect(host.requests.every((r) => r.redirect === 'manual')).toBe(true);
    });

    it('refuses an authority whose host is not HTTPS', async () => {
        host.groupEndpoint = 'http://group-host.example';
        expect(await port().open(SPACE, { delegationToken: 'd.j.t' })).toMatchObject({ ok: false, kind: 'invalid', reason: expect.stringContaining('not HTTPS') });
        expect(host.exchanges).toHaveLength(0);
    });

    it("can't open a space whose authority has no DID document, without calling it deleted", async () => {
        const opened = await port().open({ ...SPACE, authority: 'did:plc:nobodyaaaaaaaaaaaaaaaaaa' }, { delegationToken: 'd.j.t' });
        expect(opened).toMatchObject({ ok: false, kind: 'unreachable' });
    });
});
