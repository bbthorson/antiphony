import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { P256Keypair } from '@atproto/crypto';
import { createSpaceSigHeaders } from '@atproto/space';
import type { DidString } from '@atproto/syntax';
import { spaceRepo } from './space-repo.js';

/**
 * Conformance: the real `spaceRepo` adapter (over `@atproto/lex-space`) against two in-process reference
 * PDSes (`@atproto/dev-env`), one holding the space's authority and one the
 * writer. Skipped unless `DEV_ENV_PATH` names an installed dev-env, so the
 * normal suite never needs it. Rerun at every Spaces pin bump
 * (specs/spaces-beta-readiness.md):
 *
 *   mkdir -p /tmp/spaces-conf && cd /tmp/spaces-conf && npm init -y >/dev/null &&
 *     npm install @atproto/dev-env@<the pin in apps/core-api/package.json>
 *   DEV_ENV_PATH=/tmp/spaces-conf/node_modules/@atproto/dev-env \
 *     npx vitest run --root apps/core-api src/adapters/outbound/atproto/space-repo.conformance.test.ts
 *
 * Install dev-env at exactly the pin, or the hosts and the adapter speak
 * different alphas. Under npm 12, dev-env's sqlite needs its install script approved
 * (`npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3`
 * in that directory) when its prebuilt binary doesn't match the Node in use.
 */

const DEV_ENV = process.env.DEV_ENV_PATH;
const SPACE_TYPE = 'game.bardcast.space.campaign';
const SKEY = 'thornwood';
const COLLECTION = 'dev.antiphony.audio.post';

type Pds = { url: string; close(): Promise<void> };
type Account = { did: string; token: string };

async function xrpc(base: string, nsid: string, opts: { token?: string; body?: unknown; params?: Record<string, string> } = {}) {
    const url = new URL(`/xrpc/${nsid}`, base);
    for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
        method: opts.body === undefined ? 'GET' : 'POST',
        headers: {
            ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
            ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, json: json ?? {} };
}

describe.skipIf(!DEV_ENV)('spaceRepo conformance against the reference PDS', () => {
    let plc: Pds;
    let authorityHost: Pds;
    let writerHost: Pds;
    let group: Account;
    let player: Account;
    let outsider: Account;
    let space: string;
    let rkey: string;
    let recordCid: string;
    let blobCid: string;

    // The adapter insists on HTTPS; dev-env serves http://localhost. Bridge both ways.
    const bridgingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = new URL(req.url.replace(/^https:\/\/localhost/, 'http://localhost'));
        const res = await fetch(new Request(url, req));
        if (url.origin !== new URL(plc.url).origin) return res;
        const text = (await res.text()).replaceAll('http://localhost', 'https://localhost');
        return new Response(text, { status: res.status, headers: res.headers });
    }) as typeof fetch;

    const port = () => spaceRepo({ fetchImpl: bridgingFetch, plcDirectoryUrl: plc.url.replace('http://', 'https://') });
    const theSpace = () => ({ authority: group.did, type: SPACE_TYPE, skey: SKEY });
    const delegationOf = async (who: Account) => {
        const r = await xrpc(writerHost.url, 'com.atproto.space.getDelegationToken', { token: who.token, params: { space } });
        return r.json.token as string | undefined;
    };
    const account = async (pds: Pds, handle: string): Promise<Account> => {
        const r = await xrpc(pds.url, 'com.atproto.server.createAccount', {
            body: { handle, email: `${handle.split('.')[0]}@test.invalid`, password: 'conformance-password' },
        });
        if (r.status !== 200) throw new Error(`createAccount ${handle}: ${r.status} ${JSON.stringify(r.json)}`);
        return { did: String(r.json.did), token: String(r.json.accessJwt) };
    };

    beforeAll(async () => {
        const dev = await import(/* @vite-ignore */ `${DEV_ENV}/dist/index.js`);
        plc = await dev.TestPlc.create({});
        authorityHost = await dev.TestPds.create({ didPlcUrl: plc.url, inviteRequired: false });
        writerHost = await dev.TestPds.create({ didPlcUrl: plc.url, inviteRequired: false });
        group = await account(authorityHost, 'thetable.test');
        player = await account(writerHost, 'alice.test');
        outsider = await account(writerHost, 'mallory.test');

        const created = await xrpc(authorityHost.url, 'com.atproto.space.createSpace', {
            token: group.token,
            body: { spaceType: SPACE_TYPE, skey: SKEY, policy: { $type: 'com.atproto.memberspace.policy' } },
        });
        space = String(created.json.space);
        await xrpc(authorityHost.url, 'com.atproto.memberspace.putMembers', {
            token: group.token,
            body: { space, members: [{ did: player.did, read: true, write: true }] },
        });

        const up = await fetch(new URL('/xrpc/com.atproto.repo.uploadBlob', writerHost.url), {
            method: 'POST',
            headers: { authorization: `Bearer ${player.token}`, 'content-type': 'audio/mp4' },
            body: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 2, 3, 4]),
        });
        const blob = ((await up.json()) as { blob: { ref: { $link: string } } }).blob;
        blobCid = blob.ref.$link;
        const wrote = await xrpc(writerHost.url, 'com.atproto.space.createRecord', {
            token: player.token,
            body: {
                space,
                repo: player.did,
                collection: COLLECTION,
                validate: false,
                record: { $type: COLLECTION, text: 'hi', createdAt: new Date().toISOString(), embed: { $type: 'dev.antiphony.embed.audio', audio: blob } },
            },
        });
        rkey = String(wrote.json.uri).split('/').pop() as string;
        recordCid = String(wrote.json.cid);
    }, 120_000);

    afterAll(async () => {
        await writerHost?.close();
        await authorityHost?.close();
        await plc?.close();
    });

    it("publishes the writer's #atproto_kem in its DID document", async () => {
        const doc = (await (await fetch(new URL(`/${player.did}`, plc.url))).json()) as { verificationMethod?: { id: string }[] };
        expect(doc.verificationMethod?.some((m) => m.id.endsWith('#atproto_kem'))).toBe(true);
    });

    it("reads a member's record (MAC verified) and blob on a member's delegation", async () => {
        const opened = await port().open(theSpace(), { delegationToken: (await delegationOf(player)) as string });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const rec = await opened.reader.getRecord({ did: player.did, collection: COLLECTION, rkey });
        expect(rec).toMatchObject({ ok: true, value: { cid: recordCid } });
        expect(await opened.reader.getBlob(player.did, blobCid, 1 << 20)).toMatchObject({ ok: true });
        expect(await opened.reader.getRecord({ did: player.did, collection: COLLECTION, rkey: '3kaaaaaaaaaaa' })).toMatchObject({
            ok: false,
            kind: 'gone',
        });
    });

    it('spends a delegation once', async () => {
        const token = (await delegationOf(player)) as string;
        expect((await port().open(theSpace(), { delegationToken: token })).ok).toBe(true);
        expect(await port().open(theSpace(), { delegationToken: token })).toMatchObject({ ok: false, kind: 'refused' });
    });

    it("refuses an outsider's delegation", async () => {
        const token = await delegationOf(outsider);
        if (token) expect(await port().open(theSpace(), { delegationToken: token })).toMatchObject({ ok: false, kind: 'refused' });
    });

    it('is refused by the host without a MAC request', async () => {
        const key = await P256Keypair.create();
        const auth = await xrpc(authorityHost.url, 'com.atproto.space.authorizeSpaceSync', {
            body: { space, credentialKey: key.did(), delegationToken: await delegationOf(player) },
        });
        const { headers } = await createSpaceSigHeaders({
            authorization: `Atproto-Space-Credential ${String(auth.json.credential)}`,
            audience: player.did as DidString,
            keypair: key,
        });
        const url = new URL('/xrpc/com.atproto.space.getRecord', writerHost.url);
        for (const [k, v] of Object.entries({ space, repo: player.did, collection: COLLECTION, rkey })) url.searchParams.set(k, v);
        const body = (await (await fetch(url, { headers })).json()) as { error?: string };
        expect(body.error).toBe('InvalidSpaceMac');
    });

    it('reads a deleted space as deleted', async () => {
        const token = (await delegationOf(player)) as string;
        await xrpc(authorityHost.url, 'com.atproto.space.deleteSpace', { token: group.token, body: { space } });
        expect(await port().open(theSpace(), { delegationToken: token })).toMatchObject({ ok: false, kind: 'deleted' });
    });
});
