import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceError } from 'shared/errors';
import type { RemotePostView } from 'shared/types/remote-posts';
import type { RemotePostRow } from '@antiphony/core/ports/remote-posts-dependencies';

/**
 * Route tests for the remote-post XRPC methods: the queries `getRemotePost`,
 * `getRemoteThread`, `listRemotePosts` and `getRemotePosts`, and the
 * procedures `registerPost`, `reprocessRemotePost`, `unregisterPost` and
 * `recheckRemoteSpace`. The service is mocked; these cover the adapter's part:
 * auth, parameters or body in, the bare atproto shape out, processing
 * dispatch, and the XRPC error dialect with its named errors. The service's
 * own rules are in packages/core, and the queries in the Postgres suite.
 */

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const URI = `at://${DID}/dev.antiphony.audio.post/3kremote00001`;
const URI_2 = `at://${DID}/dev.antiphony.audio.post/3kremote00002`;
const SPACE = { authority: 'did:plc:group0000000000000000000', type: 'audio.voxpop.space.replies', skey: '3kprompt' };
const SPACE_URI = `at://${SPACE.authority}/space/${SPACE.type}/${SPACE.skey}`;
const row = (uri: string) => ({ uri }) as RemotePostRow;
const view = (uri: string): RemotePostView => ({
    uri,
    cid: 'bafyreirecord',
    kind: 'prompt',
    authorDid: DID,
    verified: 'fetched',
    deletionCheck: 'sweep',
    record: { text: 'hi', createdAt: new Date('2026-11-02T10:00:00.000Z') },
    available: true,
    registeredAt: '2026-11-02T12:00:00.000Z',
});

const remotePostService = {
    register: vi.fn(),
    get: vi.fn(),
    thread: vi.fn(),
    requestProcessing: vi.fn(),
    delete: vi.fn(),
    recheckSpace: vi.fn(),
    list: vi.fn(),
    getMany: vi.fn(),
    hydrate: vi.fn(),
};
const dispatchRemoteProcessing = vi.fn(async () => undefined);

vi.mock('../../../composition.js', () => ({
    servicesFor: () => ({
        remotePostService,
        rateLimitStore: { hit: async () => 'under' as const },
    }),
}));

vi.mock('../../../lib/audio-processing.js', async (importOriginal) => ({
    ...((await importOriginal()) as object),
    dispatchRemoteProcessing,
    // Every stage is runnable here, so a request resolves to `pending`.
    resolveInitialProcessing: (_app: string, req: Record<string, boolean> | undefined) =>
        req && Object.values(req).some(Boolean)
            ? Object.fromEntries(Object.entries(req).filter(([, v]) => v).map(([k]) => [k, 'pending']))
            : undefined,
}));

const SERVICE_TOKEN = 'svc-tok-abcdefghijklmnopqrstuvwxyz012345';
process.env.LOG_LEVEL = 'silent';
process.env.ANTIPHONY_APP_TOKENS = `test-app:${SERVICE_TOKEN}`;

const { app } = await import('../../../app.js');
const { seedValidatedPins } = await import('../../../lib/testing/seed-pins.js');
await seedValidatedPins({ 'test-app': 'did:web:test-app.example' });

const auth = { authorization: `Bearer ${SERVICE_TOKEN}` };
const LIST = '/xrpc/dev.antiphony.audio.listRemotePosts';
const GET = '/xrpc/dev.antiphony.audio.getRemotePosts';
const get = (path: string, headers: Record<string, string> = auth) => app().request(path, { headers });
const post = (nsid: string, body: unknown, headers: Record<string, string> = auth) =>
    app().request(`/xrpc/${nsid}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
const TOKEN = 'eyJhbGciOiJFUzI1NiJ9.e30.c2ln';
const ATTESTATION = 'eyJhbGciOiJFUzI1NiJ9.e30.YXR0';

beforeEach(() => {
    for (const fn of Object.values(remotePostService)) fn.mockReset();
    dispatchRemoteProcessing.mockClear();
    remotePostService.hydrate.mockImplementation(async (_o: string, rows: RemotePostRow[]) => rows.map((r) => view(r.uri)));
    remotePostService.get.mockImplementation(async (_o: string, uri: string) => row(uri));
});

/** A body is the bare XRPC answer: no REST envelope around it. */
function expectBare(body: Record<string, unknown>) {
    expect(body).not.toHaveProperty('success');
    expect(body).not.toHaveProperty('data');
}

describe('dev.antiphony.audio.listRemotePosts', () => {
    it('needs a service token, and answers in the XRPC dialect without one', async () => {
        const res = await get(LIST, {});
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'AuthenticationRequired' });
    });

    it('lists with the default limit and no filter, as a named array with a cursor', async () => {
        remotePostService.list.mockResolvedValue({ rows: [row(URI), row(URI_2)], cursor: 'next' });
        const res = await get(LIST);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ posts: [{ uri: URI }, { uri: URI_2 }], cursor: 'next' });
        // The bare XRPC body, not the REST envelope.
        expect(body).not.toHaveProperty('success');
        expect(remotePostService.list).toHaveBeenCalledWith('test-app', {}, { limit: 50 });
    });

    it('leaves `cursor` out on the last page rather than sending null', async () => {
        remotePostService.list.mockResolvedValue({ rows: [row(URI)] });
        const body = await (await get(LIST)).json();
        expect(body).toEqual({ posts: [expect.objectContaining({ uri: URI })] });
    });

    it('passes repo, space, kind, limit and cursor through, with the space parsed', async () => {
        remotePostService.list.mockResolvedValue({ rows: [] });
        const query = new URLSearchParams({ repo: DID, space: SPACE_URI, kind: 'reply', limit: '10', cursor: 'abc' });
        const res = await get(`${LIST}?${query}`);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ posts: [] });
        expect(remotePostService.list).toHaveBeenCalledWith(
            'test-app',
            { repoDid: DID, space: SPACE, kind: 'reply' },
            { limit: 10, cursor: 'abc' },
        );
    });

    it.each([
        ['a limit over 100', 'limit=101'],
        ['a limit of zero', 'limit=0'],
        ['an unknown kind', 'kind=draft'],
        ['a repo that is not a DID', 'repo=alice.example'],
        ['a space that is not a space URI', `space=${encodeURIComponent(URI)}`],
    ])('refuses %s as InvalidRequest', async (_label, query) => {
        const res = await get(`${LIST}?${query}`);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'InvalidRequest' });
        expect(remotePostService.list).not.toHaveBeenCalled();
    });

    it("names a cursor it didn't issue InvalidCursor, as the lexicon declares", async () => {
        remotePostService.list.mockRejectedValue(new ServiceError('Invalid cursor', 400, undefined, 'INVALID_CURSOR'));
        const res = await get(`${LIST}?cursor=nope`);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'InvalidCursor' });
    });
});

describe('dev.antiphony.audio.getRemotePosts', () => {
    const uris = (...list: string[]) => list.map((u) => `uris=${encodeURIComponent(u)}`).join('&');

    it('reads a repeated `uris` parameter, and one on its own', async () => {
        remotePostService.getMany.mockResolvedValue([row(URI_2), row(URI)]);
        const res = await get(`${GET}?${uris(URI_2, URI)}`);

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ posts: [{ uri: URI_2 }, { uri: URI }] });
        expect(remotePostService.getMany).toHaveBeenCalledWith('test-app', [URI_2, URI]);

        remotePostService.getMany.mockResolvedValue([row(URI)]);
        await get(`${GET}?${uris(URI)}`);
        expect(remotePostService.getMany).toHaveBeenLastCalledWith('test-app', [URI]);
    });

    it('answers an empty list, not an error, when none is registered', async () => {
        remotePostService.getMany.mockResolvedValue([]);
        const res = await get(`${GET}?${uris(URI)}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ posts: [] });
    });

    it('refuses no URI, more than 25, or one that is not an at:// URI', async () => {
        const many = Array.from({ length: 26 }, (_, i) => `${URI}${i}`);
        for (const query of ['', uris(...many), 'uris=https%3A%2F%2Fexample.com']) {
            const res = await get(`${GET}?${query}`);
            expect(res.status, query.slice(0, 40)).toBe(400);
            expect(await res.json()).toMatchObject({ error: 'InvalidRequest' });
        }
        expect(remotePostService.getMany).not.toHaveBeenCalled();
    });
});

describe('dev.antiphony.audio.getRemotePost', () => {
    const GET_ONE = '/xrpc/dev.antiphony.audio.getRemotePost';

    it('needs a service token, and nothing more', async () => {
        const res = await get(`${GET_ONE}?uri=${encodeURIComponent(URI)}`, {});
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'AuthenticationRequired' });

        // No acting actor: a remote post is tenant-level.
        expect((await get(`${GET_ONE}?uri=${encodeURIComponent(URI)}`)).status).toBe(200);
    });

    it('answers the bare view', async () => {
        const res = await get(`${GET_ONE}?uri=${encodeURIComponent(URI)}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expectBare(body);
        expect(body).toMatchObject({ uri: URI, available: true, verified: 'fetched' });
        expect(remotePostService.get).toHaveBeenCalledWith('test-app', URI);
    });

    it('refuses a missing uri, or one that is not at://', async () => {
        for (const query of ['', '?uri=https%3A%2F%2Fexample.com']) {
            const res = await get(`${GET_ONE}${query}`);
            expect(res.status).toBe(400);
            expect(await res.json()).toMatchObject({ error: 'InvalidRequest' });
        }
        expect(remotePostService.get).not.toHaveBeenCalled();
    });

    it.each([
        [404, 'REMOTE_POST_NOT_FOUND', 'RemotePostNotFound'],
        [410, 'REMOTE_POST_DELETED', 'RemotePostDeleted'],
    ])('names a %i %s as %s', async (status, code, name) => {
        remotePostService.get.mockRejectedValue(new ServiceError('nope', status, undefined, code));
        const res = await get(`${GET_ONE}?uri=${encodeURIComponent(URI)}`);
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ error: name, message: 'nope' });
    });
});

describe('dev.antiphony.audio.getRemoteThread', () => {
    const THREAD = '/xrpc/dev.antiphony.audio.getRemoteThread';
    const root = (extra = '') => `${THREAD}?root=${encodeURIComponent(URI)}${extra}`;

    it('needs a service token', async () => {
        const res = await get(root(), {});
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'AuthenticationRequired' });
    });

    it('answers the root, the replies and a cursor, with the default limit', async () => {
        remotePostService.thread.mockResolvedValue({ root: row(URI), replies: [row(URI_2)], nextCursor: URI_2 });
        const res = await get(root());

        expect(res.status).toBe(200);
        const body = await res.json();
        expectBare(body);
        expect(body).toMatchObject({ root: { uri: URI }, replies: [{ uri: URI_2 }], cursor: URI_2 });
        expect(body).not.toHaveProperty('nextCursor');
        expect(remotePostService.thread).toHaveBeenCalledWith('test-app', URI, { limit: 50 });
    });

    it('leaves out `root` and `cursor` rather than sending null', async () => {
        // A later page (or a root that isn't registered) has no root; the last
        // page has no cursor.
        remotePostService.thread.mockResolvedValue({ root: null, replies: [row(URI_2)], nextCursor: null });
        const body = await (await get(root('&cursor=abc&limit=10'))).json();

        expect(body).toEqual({ replies: [expect.objectContaining({ uri: URI_2 })] });
        expect(remotePostService.thread).toHaveBeenCalledWith('test-app', URI, { limit: 10, cursor: 'abc' });
    });

    it('answers an empty page, not an error, for a root with no registered replies', async () => {
        remotePostService.thread.mockResolvedValue({ root: null, replies: [], nextCursor: null });
        const res = await get(root());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ replies: [] });
    });

    it.each([
        ['no root', THREAD],
        ['a root that is not at://', `${THREAD}?root=https%3A%2F%2Fexample.com`],
        ['a limit over 100', root('&limit=101')],
        ['a limit of zero', root('&limit=0')],
        ['an empty cursor', root('&cursor=')],
    ])('refuses %s as InvalidRequest', async (_label, path) => {
        const res = await get(path);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'InvalidRequest' });
        expect(remotePostService.thread).not.toHaveBeenCalled();
    });
});

describe('dev.antiphony.audio.registerPost', () => {
    const NSID = 'dev.antiphony.audio.registerPost';
    const SPACED = `at://${SPACE.authority}/space/${SPACE.type}/${SPACE.skey}/${DID}/dev.antiphony.audio.post/3kremote00003`;

    it('needs a service token, and no acting actor', async () => {
        const res = await post(NSID, { uri: URI, cid: 'bafyreirecord' }, {});
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'AuthenticationRequired' });
        expect(remotePostService.register).not.toHaveBeenCalled();
    });

    it('answers 200 with the bare view for a first registration, without dispatching when no stage is pending', async () => {
        remotePostService.register.mockResolvedValue({ row: row(URI), outcome: 'created', dispatch: false });
        const res = await post(NSID, { uri: URI, cid: 'bafyreirecord' });

        // REST says 201 here; XRPC has no created status.
        expect(res.status).toBe(200);
        const body = await res.json();
        expectBare(body);
        expect(body).toMatchObject({ uri: URI, available: true });
        expect(remotePostService.register).toHaveBeenCalledWith('test-app', { uri: URI, cid: 'bafyreirecord' });
        expect(dispatchRemoteProcessing).not.toHaveBeenCalled();
        // The registered row is the view's source; nothing is re-read.
        expect(remotePostService.get).not.toHaveBeenCalled();
    });

    it('answers 200 for a repeat or an edit too', async () => {
        for (const outcome of ['unchanged', 'updated']) {
            remotePostService.register.mockResolvedValue({ row: row(URI), outcome, dispatch: false });
            expect((await post(NSID, { uri: URI, cid: 'bafyreirecord' })).status).toBe(200);
        }
    });

    it('passes the resolved stages on, dispatches by URI, and answers the re-read row', async () => {
        remotePostService.register.mockResolvedValue({ row: row(URI), outcome: 'created', dispatch: true });
        remotePostService.get.mockResolvedValue(row(URI_2));
        const res = await post(NSID, { uri: URI, cid: 'bafyreirecord', processing: { transcribe: true } });

        expect(res.status).toBe(200);
        expect(remotePostService.register).toHaveBeenCalledWith('test-app', {
            uri: URI,
            cid: 'bafyreirecord',
            processing: { transcribe: 'pending' },
        });
        expect(dispatchRemoteProcessing).toHaveBeenCalledWith('test-app', URI, undefined);
        // The view comes from the row read after dispatch, so it carries any
        // processing that ran inline.
        expect(remotePostService.get).toHaveBeenCalledWith('test-app', URI);
        expect(await res.json()).toMatchObject({ uri: URI_2 });
    });

    it('passes a pushed space record on with its body and bytesFrom, inside the 64 KB limit', async () => {
        remotePostService.register.mockResolvedValue({ row: row(SPACED), outcome: 'created', dispatch: false });
        const record = { $type: 'dev.antiphony.audio.post', text: 'x'.repeat(3000), createdAt: '2026-11-02T10:00:00.000Z' };
        const res = await post(NSID, { uri: SPACED, cid: 'bafyreirecord', bytesFrom: 'upload', record });

        expect(res.status).toBe(200);
        expect(remotePostService.register).toHaveBeenCalledWith('test-app', {
            uri: SPACED,
            cid: 'bafyreirecord',
            bytesFrom: 'upload',
            record,
        });
    });

    it('passes a delegation and attestation on for a space record', async () => {
        remotePostService.register.mockResolvedValue({ row: row(SPACED), outcome: 'created', dispatch: false });
        await post(NSID, { uri: SPACED, cid: 'bafyreirecord', delegationToken: TOKEN, clientAttestation: ATTESTATION });
        expect(remotePostService.register).toHaveBeenCalledWith('test-app', {
            uri: SPACED,
            cid: 'bafyreirecord',
            delegationToken: TOKEN,
            clientAttestation: ATTESTATION,
        });
    });

    it.each([
        ['no cid', { uri: URI }],
        ['a uri that is not at://', { uri: 'https://example.com', cid: 'x' }],
        ['an unknown bytesFrom', { uri: URI, cid: 'bafyreirecord', bytesFrom: 'proxy' }],
        ['a delegation that is not a JWT', { uri: URI, cid: 'bafyreirecord', delegationToken: 'not a token' }],
        ['a record that is not an object', { uri: URI, cid: 'bafyreirecord', record: 'text' }],
    ])('refuses %s as InvalidRequest, naming the field', async (_label, body) => {
        const res = await post(NSID, body);
        expect(res.status).toBe(400);
        const answer = await res.json();
        expect(answer.error).toBe('InvalidRequest');
        expect(answer.message).not.toBe('');
        expect(remotePostService.register).not.toHaveBeenCalled();
    });

    it('refuses a malformed JSON body as InvalidRequest', async () => {
        const res = await post(NSID, '{"uri":');
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'InvalidRequest' });
    });

    it('refuses a body over 64 KB as PayloadTooLarge, in the XRPC dialect', async () => {
        const res = await post(NSID, { uri: URI, cid: 'bafyreirecord', record: { text: 'x'.repeat(65 * 1024) } });
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({ error: 'PayloadTooLarge', message: 'Request body too large' });
        expect(remotePostService.register).not.toHaveBeenCalled();
    });

    it.each([
        [400, 'REMOTE_URI_UNSUPPORTED', 'RemoteUriUnsupported'],
        [400, 'REMOTE_REQUEST_INVALID', 'RemoteRequestInvalid'],
        [403, 'REMOTE_DELEGATION_REFUSED', 'RemoteDelegationRefused'],
        [404, 'REMOTE_RECORD_NOT_FOUND', 'RemoteRecordNotFound'],
        [503, 'REMOTE_REPO_UNREACHABLE', 'RemoteRepoUnreachable'],
        [409, 'REMOTE_CID_MISMATCH', 'RemoteCidMismatch'],
        [422, 'REMOTE_RECORD_INVALID', 'RemoteRecordInvalid'],
        [409, 'REMOTE_BLOB_SPACE_MISMATCH', 'RemoteBlobSpaceMismatch'],
    ])("names the service's %i %s as %s", async (status, code, name) => {
        remotePostService.register.mockRejectedValue(new ServiceError('refused', status, { reason: 'x' }, code));
        const res = await post(NSID, { uri: URI, cid: 'bafyreirecord' });
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ error: name, message: 'refused' });
        expect(dispatchRemoteProcessing).not.toHaveBeenCalled();
    });
});

describe('dev.antiphony.audio.reprocessRemotePost', () => {
    const NSID = 'dev.antiphony.audio.reprocessRemotePost';

    it('needs a service token', async () => {
        const res = await post(NSID, { uri: URI, processing: { waveform: true } }, {});
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'AuthenticationRequired' });
    });

    it('requests the stages with the URI from the body, dispatches, and answers the bare view', async () => {
        remotePostService.requestProcessing.mockResolvedValue({ row: row(URI), dispatch: true });
        const res = await post(NSID, { uri: URI, processing: { waveform: true } });

        expect(res.status).toBe(200);
        const body = await res.json();
        expectBare(body);
        expect(body).toMatchObject({ uri: URI });
        expect(remotePostService.requestProcessing).toHaveBeenCalledWith('test-app', URI, { waveform: 'pending' });
        expect(dispatchRemoteProcessing).toHaveBeenCalledWith('test-app', URI, undefined);
    });

    it('does not dispatch when nothing is left pending', async () => {
        remotePostService.requestProcessing.mockResolvedValue({ row: row(URI), dispatch: false });
        expect((await post(NSID, { uri: URI, processing: { waveform: true } })).status).toBe(200);
        expect(dispatchRemoteProcessing).not.toHaveBeenCalled();
    });

    it('refuses a request that names no stage, before reading anything', async () => {
        const res = await post(NSID, { uri: URI, processing: { transcribe: false } });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            error: 'InvalidRequest',
            message: 'Request must enable at least one processing stage',
        });
        expect(remotePostService.requestProcessing).not.toHaveBeenCalled();
    });

    it.each([
        ['no uri', { processing: { waveform: true } }],
        ['no processing', { uri: URI }],
        ['a uri that is not at://', { uri: 'https://example.com', processing: { waveform: true } }],
    ])('refuses %s as InvalidRequest', async (_label, body) => {
        const res = await post(NSID, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'InvalidRequest' });
        expect(remotePostService.requestProcessing).not.toHaveBeenCalled();
    });

    it('refuses a body over 8 KB as PayloadTooLarge', async () => {
        const res = await post(NSID, { uri: URI, processing: { waveform: true }, pad: 'x'.repeat(9 * 1024) });
        expect(res.status).toBe(413);
        expect(await res.json()).toMatchObject({ error: 'PayloadTooLarge' });
    });

    it.each([
        [404, 'REMOTE_POST_NOT_FOUND', 'RemotePostNotFound'],
        [410, 'REMOTE_POST_DELETED', 'RemotePostDeleted'],
    ])('names a %i %s as %s', async (status, code, name) => {
        remotePostService.requestProcessing.mockRejectedValue(new ServiceError('nope', status, undefined, code));
        const res = await post(NSID, { uri: URI, processing: { waveform: true } });
        expect(res.status).toBe(status);
        expect(await res.json()).toMatchObject({ error: name });
        expect(dispatchRemoteProcessing).not.toHaveBeenCalled();
    });
});

describe('dev.antiphony.audio.unregisterPost', () => {
    const NSID = 'dev.antiphony.audio.unregisterPost';

    it('needs a service token', async () => {
        const res = await post(NSID, { uri: URI }, {});
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'AuthenticationRequired' });
        expect(remotePostService.delete).not.toHaveBeenCalled();
    });

    it('answers whether a registration was removed, as a bare body', async () => {
        remotePostService.delete.mockResolvedValue(true);
        const res = await post(NSID, { uri: URI });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ uri: URI, deleted: true });
        expect(remotePostService.delete).toHaveBeenCalledWith('test-app', URI);

        // Idempotent: nothing to remove is still a 200.
        remotePostService.delete.mockResolvedValue(false);
        expect(await (await post(NSID, { uri: URI })).json()).toEqual({ uri: URI, deleted: false });
    });

    it('refuses no uri, or one that is not at://', async () => {
        for (const body of [{}, { uri: 'https://example.com' }]) {
            const res = await post(NSID, body);
            expect(res.status).toBe(400);
            expect(await res.json()).toMatchObject({ error: 'InvalidRequest' });
        }
        expect(remotePostService.delete).not.toHaveBeenCalled();
    });

    it('refuses a body over 8 KB as PayloadTooLarge', async () => {
        const res = await post(NSID, { uri: URI, pad: 'x'.repeat(9 * 1024) });
        expect(res.status).toBe(413);
        expect(await res.json()).toMatchObject({ error: 'PayloadTooLarge' });
    });
});

describe('dev.antiphony.audio.recheckRemoteSpace', () => {
    const NSID = 'dev.antiphony.audio.recheckRemoteSpace';

    it('needs a service token', async () => {
        const res = await post(NSID, { space: SPACE_URI, delegationToken: TOKEN }, {});
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'AuthenticationRequired' });
        expect(remotePostService.recheckSpace).not.toHaveBeenCalled();
    });

    it('rechecks the space, dispatches each edit, and answers the counts without the dispatch list', async () => {
        remotePostService.recheckSpace.mockResolvedValue({
            space: SPACE_URI,
            checked: 3,
            removed: 1,
            changed: 2,
            remaining: true,
            toDispatch: [
                { originAppId: 'test-app', uri: URI },
                { originAppId: 'test-app', uri: URI_2 },
            ],
        });
        const res = await post(NSID, { space: SPACE_URI, delegationToken: TOKEN, clientAttestation: ATTESTATION });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ space: SPACE_URI, checked: 3, removed: 1, changed: 2, remaining: true });
        expect(remotePostService.recheckSpace).toHaveBeenCalledWith('test-app', SPACE_URI, {
            delegationToken: TOKEN,
            clientAttestation: ATTESTATION,
        });
        expect(dispatchRemoteProcessing).toHaveBeenCalledTimes(2);
        expect(dispatchRemoteProcessing).toHaveBeenCalledWith('test-app', URI, undefined);
        expect(dispatchRemoteProcessing).toHaveBeenCalledWith('test-app', URI_2, undefined);
    });

    it.each([
        ['no delegation', { space: SPACE_URI }],
        ['a post URI where a space URI belongs', { space: URI, delegationToken: TOKEN }],
        ['a delegation that is not a JWT', { space: SPACE_URI, delegationToken: 'not a token' }],
    ])('refuses %s as InvalidRequest', async (_label, body) => {
        const res = await post(NSID, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'InvalidRequest' });
        expect(remotePostService.recheckSpace).not.toHaveBeenCalled();
    });

    it('refuses a body over 32 KB as PayloadTooLarge', async () => {
        const res = await post(NSID, { space: SPACE_URI, delegationToken: TOKEN, pad: 'x'.repeat(33 * 1024) });
        expect(res.status).toBe(413);
        expect(await res.json()).toMatchObject({ error: 'PayloadTooLarge' });
    });

    it.each([
        [400, 'REMOTE_URI_UNSUPPORTED', 'RemoteUriUnsupported'],
        [403, 'REMOTE_DELEGATION_REFUSED', 'RemoteDelegationRefused'],
        [503, 'REMOTE_REPO_UNREACHABLE', 'RemoteRepoUnreachable'],
        [422, 'REMOTE_RECORD_INVALID', 'RemoteRecordInvalid'],
    ])("names the service's %i %s as %s, and dispatches nothing", async (status, code, name) => {
        remotePostService.recheckSpace.mockRejectedValue(new ServiceError('refused', status, undefined, code));
        const res = await post(NSID, { space: SPACE_URI, delegationToken: TOKEN });
        expect(res.status).toBe(status);
        expect(await res.json()).toMatchObject({ error: name });
        expect(dispatchRemoteProcessing).not.toHaveBeenCalled();
    });
});
