import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceError } from 'shared/errors';
import type { RemotePostView } from 'shared/types/remote-posts';
import type { RemotePostRow } from '@antiphony/core/ports/remote-posts-dependencies';

/**
 * Route tests for `/api/v1/remote-posts`: auth, validation, status codes,
 * dispatch and the envelope. The service's own rules have their suite in
 * packages/core, and the Postgres binding its own.
 */

const URI = 'at://did:plc:abcdefghijklmnopqrstuvwx/dev.antiphony.audio.post/3kremote00001';
const ROW = { uri: URI } as RemotePostRow;
const VIEW: RemotePostView = {
    uri: URI,
    cid: 'bafyreirecord',
    kind: 'prompt',
    authorDid: 'did:plc:abcdefghijklmnopqrstuvwx',
    verified: 'fetched',
    deletionCheck: 'sweep',
    record: { text: 'hi', createdAt: new Date('2026-11-02T10:00:00.000Z') },
    available: true,
    registeredAt: '2026-11-02T12:00:00.000Z',
};

const remotePostService = {
    register: vi.fn(),
    get: vi.fn(),
    hydrate: vi.fn(),
    thread: vi.fn(),
    requestProcessing: vi.fn(),
    delete: vi.fn(),
    recheckSpace: vi.fn(),
    list: vi.fn(),
    getMany: vi.fn(),
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
const json = { ...auth, 'content-type': 'application/json' };
const q = (uri = URI) => `?uri=${encodeURIComponent(uri)}`;

describe('/api/v1/remote-posts', () => {
    beforeEach(() => {
        for (const fn of Object.values(remotePostService)) fn.mockReset();
        dispatchRemoteProcessing.mockClear();
        remotePostService.hydrate.mockResolvedValue([VIEW]);
        remotePostService.get.mockResolvedValue(ROW);
    });

    it('refuses an unauthenticated call', async () => {
        const res = await app().request(`/api/v1/remote-posts${q()}`);
        expect(res.status).toBe(401);
    });

    describe('PUT', () => {
        const put = (body: unknown) =>
            app().request('/api/v1/remote-posts', { method: 'PUT', headers: json, body: JSON.stringify(body) });

        it('registers (201) and returns the view, without dispatching when no stage is requested', async () => {
            remotePostService.register.mockResolvedValue({ row: ROW, outcome: 'created', dispatch: false });
            const res = await put({ uri: URI, cid: 'bafyreirecord' });

            expect(res.status).toBe(201);
            expect((await res.json()).data).toMatchObject({ uri: URI, available: true });
            expect(remotePostService.register).toHaveBeenCalledWith('test-app', { uri: URI, cid: 'bafyreirecord' });
            expect(dispatchRemoteProcessing).not.toHaveBeenCalled();
        });

        it('passes the resolved stages on and dispatches by URI', async () => {
            remotePostService.register.mockResolvedValue({ row: ROW, outcome: 'created', dispatch: true });
            await put({ uri: URI, cid: 'bafyreirecord', processing: { transcribe: true } });

            expect(remotePostService.register).toHaveBeenCalledWith('test-app', {
                uri: URI,
                cid: 'bafyreirecord',
                processing: { transcribe: 'pending' },
            });
            expect(dispatchRemoteProcessing).toHaveBeenCalledWith('test-app', URI, undefined);
        });

        it('passes a pushed space record on with its body and bytesFrom', async () => {
            remotePostService.register.mockResolvedValue({ row: ROW, outcome: 'created', dispatch: false });
            const spaced = `at://did:plc:group0000000000000000000/space/game.bardcast.space.campaign/c1/did:plc:abcdefghijklmnopqrstuvwx/dev.antiphony.audio.post/3k`;
            const record = { $type: 'dev.antiphony.audio.post', text: 'x'.repeat(3000), createdAt: '2026-11-02T10:00:00.000Z' };
            const res = await put({ uri: spaced, cid: 'bafyreirecord', bytesFrom: 'upload', record });

            // Bigger than Phase A's 8 KB: a pushed record carries its text and waveform.
            expect(res.status).toBe(201);
            expect(remotePostService.register).toHaveBeenCalledWith('test-app', {
                uri: spaced,
                cid: 'bafyreirecord',
                bytesFrom: 'upload',
                record,
            });
        });

        it('passes a delegation and attestation on for a space record', async () => {
            remotePostService.register.mockResolvedValue({ row: ROW, outcome: 'created', dispatch: false });
            const spaced = `at://did:plc:groupaaaaaaaaaaaaaaaaaaa/space/game.bardcast.space.campaign/c1/did:plc:abcdefghijklmnopqrstuvwx/dev.antiphony.audio.post/3k`;
            await put({ uri: spaced, cid: 'bafyreirecord', delegationToken: 'eyJhbGciOiJFUzI1NiJ9.e30.c2ln', clientAttestation: 'eyJhbGciOiJFUzI1NiJ9.e30.YXR0' });
            expect(remotePostService.register).toHaveBeenCalledWith('test-app', {
                uri: spaced,
                cid: 'bafyreirecord',
                delegationToken: 'eyJhbGciOiJFUzI1NiJ9.e30.c2ln',
                clientAttestation: 'eyJhbGciOiJFUzI1NiJ9.e30.YXR0',
            });
        });

        it('refuses a delegation that is not a JWT', async () => {
            expect((await put({ uri: URI, cid: 'bafyreirecord', delegationToken: 'not a token' })).status).toBe(400);
            expect(remotePostService.register).not.toHaveBeenCalled();
        });

        it('refuses an unknown bytesFrom', async () => {
            expect((await put({ uri: URI, cid: 'bafyreirecord', bytesFrom: 'proxy' })).status).toBe(400);
            expect(remotePostService.register).not.toHaveBeenCalled();
        });

        it('answers 200 for a repeat or an edit', async () => {
            remotePostService.register.mockResolvedValue({ row: ROW, outcome: 'unchanged', dispatch: false });
            expect((await put({ uri: URI, cid: 'bafyreirecord' })).status).toBe(200);
        });

        it('refuses a body without a CID, or a URI that is not at://', async () => {
            expect((await put({ uri: URI })).status).toBe(400);
            expect((await put({ uri: 'https://example.com', cid: 'x' })).status).toBe(400);
            expect(remotePostService.register).not.toHaveBeenCalled();
        });

        it("maps the service's refusals to their status and code", async () => {
            remotePostService.register.mockRejectedValue(
                new ServiceError('changed', 409, { currentCid: 'bafynew' }, 'REMOTE_CID_MISMATCH'),
            );
            const res = await put({ uri: URI, cid: 'bafyold' });
            expect(res.status).toBe(409);
            expect((await res.json()).error).toMatchObject({ code: 'REMOTE_CID_MISMATCH' });
        });
    });

    it('GET returns one post, and passes a 410 through', async () => {
        const ok = await app().request(`/api/v1/remote-posts${q()}`, { headers: auth });
        expect(ok.status).toBe(200);
        expect(remotePostService.get).toHaveBeenCalledWith('test-app', URI);

        remotePostService.get.mockRejectedValue(new ServiceError('removed', 410, undefined, 'REMOTE_POST_DELETED'));
        const gone = await app().request(`/api/v1/remote-posts${q()}`, { headers: auth });
        expect(gone.status).toBe(410);
    });

    it('GET /thread returns the root and replies, paged', async () => {
        remotePostService.thread.mockResolvedValue({ root: ROW, replies: [ROW], nextCursor: URI });
        remotePostService.hydrate.mockImplementation(async (_o: string, rows: unknown[]) => rows.map(() => VIEW));

        const res = await app().request(`/api/v1/remote-posts/thread?root=${encodeURIComponent(URI)}&limit=10`, {
            headers: auth,
        });
        expect(res.status).toBe(200);
        expect((await res.json()).data).toMatchObject({ root: { uri: URI }, replies: [{ uri: URI }], nextCursor: URI });
        expect(remotePostService.thread).toHaveBeenCalledWith('test-app', URI, { limit: 10 });
    });

    describe('GET /list', () => {
        const list = (query = '') => app().request(`/api/v1/remote-posts/list${query}`, { headers: auth });

        it('answers the XRPC list shape inside the envelope: posts, and a cursor only when a page follows', async () => {
            remotePostService.list.mockResolvedValue({ rows: [ROW], cursor: 'next' });
            const res = await list();
            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ success: true, data: { posts: [{ uri: URI }], cursor: 'next' } });
            expect(remotePostService.list).toHaveBeenCalledWith('test-app', {}, { limit: 50 });

            remotePostService.list.mockResolvedValue({ rows: [] });
            remotePostService.hydrate.mockResolvedValue([]);
            expect((await (await list()).json()).data).toEqual({ posts: [] });
        });

        it('passes the filters through, with the space parsed', async () => {
            remotePostService.list.mockResolvedValue({ rows: [ROW] });
            const space = 'at://did:plc:group0000000000000000000/space/audio.voxpop.space.replies/3kprompt';
            const query = new URLSearchParams({ repo: 'did:plc:abcdefghijklmnopqrstuvwx', space, kind: 'reply', limit: '5', cursor: 'c' });
            expect((await list(`?${query}`)).status).toBe(200);
            expect(remotePostService.list).toHaveBeenCalledWith(
                'test-app',
                {
                    repoDid: 'did:plc:abcdefghijklmnopqrstuvwx',
                    space: { authority: 'did:plc:group0000000000000000000', type: 'audio.voxpop.space.replies', skey: '3kprompt' },
                    kind: 'reply',
                },
                { limit: 5, cursor: 'c' },
            );
        });

        it('refuses a bad limit or kind (400), and is not mistaken for GET /?uri=', async () => {
            expect((await list('?limit=101')).status).toBe(400);
            expect((await list('?kind=draft')).status).toBe(400);
            expect(remotePostService.get).not.toHaveBeenCalled();
        });
    });

    describe('GET /batch', () => {
        const batch = (uris: string[]) =>
            app().request(`/api/v1/remote-posts/batch?${uris.map((u) => `uris=${encodeURIComponent(u)}`).join('&')}`, { headers: auth });

        it('reads one URI or several, in the envelope', async () => {
            remotePostService.getMany.mockResolvedValue([ROW]);
            const res = await batch([URI]);
            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ success: true, data: { posts: [{ uri: URI }] } });
            expect(remotePostService.getMany).toHaveBeenCalledWith('test-app', [URI]);

            await batch([URI, `${URI}2`]);
            expect(remotePostService.getMany).toHaveBeenLastCalledWith('test-app', [URI, `${URI}2`]);
        });

        it('refuses none, or more than 25 (400)', async () => {
            expect((await batch([])).status).toBe(400);
            expect((await batch(Array.from({ length: 26 }, (_, i) => `${URI}${i}`))).status).toBe(400);
            expect(remotePostService.getMany).not.toHaveBeenCalled();
        });
    });

    describe('PATCH', () => {
        const patch = (body: unknown) =>
            app().request(`/api/v1/remote-posts${q()}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) });

        it('requests the stages and dispatches', async () => {
            remotePostService.requestProcessing.mockResolvedValue({ row: ROW, dispatch: true });
            const res = await patch({ processing: { waveform: true } });
            expect(res.status).toBe(200);
            expect(remotePostService.requestProcessing).toHaveBeenCalledWith('test-app', URI, { waveform: 'pending' });
            expect(dispatchRemoteProcessing).toHaveBeenCalledWith('test-app', URI, undefined);
        });

        it('refuses a request that names no stage', async () => {
            expect((await patch({ processing: { transcribe: false } })).status).toBe(400);
            expect(remotePostService.requestProcessing).not.toHaveBeenCalled();
        });
    });

    it('DELETE reports whether a registration was removed', async () => {
        remotePostService.delete.mockResolvedValue(true);
        const res = await app().request(`/api/v1/remote-posts${q()}`, { method: 'DELETE', headers: auth });
        expect(res.status).toBe(200);
        expect((await res.json()).data).toEqual({ uri: URI, deleted: true });
    });

    describe('POST /recheck', () => {
        const SPACE = 'at://did:plc:groupaaaaaaaaaaaaaaaaaaa/space/game.bardcast.space.campaign/thornwood';
        const TOKEN = 'eyJhbGciOiJFUzI1NiJ9.e30.c2ln';
        const recheck = (body: unknown) =>
            app().request('/api/v1/remote-posts/recheck', { method: 'POST', headers: json, body: JSON.stringify(body) });

        it('rechecks the space, dispatches edits, and returns the counts', async () => {
            remotePostService.recheckSpace.mockResolvedValue({
                space: SPACE,
                checked: 2,
                removed: 0,
                changed: 1,
                remaining: false,
                toDispatch: [{ originAppId: 'test-app', uri: URI }],
            });
            const res = await recheck({ space: SPACE, delegationToken: TOKEN });

            expect(res.status).toBe(200);
            expect((await res.json()).data).toEqual({ space: SPACE, checked: 2, removed: 0, changed: 1, remaining: false });
            expect(remotePostService.recheckSpace).toHaveBeenCalledWith('test-app', SPACE, { delegationToken: TOKEN });
            expect(dispatchRemoteProcessing).toHaveBeenCalledWith('test-app', URI, undefined);
        });

        it('passes a refusal through', async () => {
            remotePostService.recheckSpace.mockRejectedValue(new ServiceError('refused', 403, undefined, 'REMOTE_DELEGATION_REFUSED'));
            const res = await recheck({ space: SPACE, delegationToken: TOKEN });
            expect(res.status).toBe(403);
            expect((await res.json()).error).toMatchObject({ code: 'REMOTE_DELEGATION_REFUSED' });
        });

        it('refuses a body without a delegation, or a URI that is not a space', async () => {
            expect((await recheck({ space: SPACE })).status).toBe(400);
            expect((await recheck({ space: URI, delegationToken: TOKEN })).status).toBe(400);
            expect(remotePostService.recheckSpace).not.toHaveBeenCalled();
        });

        it('refuses an unauthenticated call', async () => {
            const res = await app().request('/api/v1/remote-posts/recheck', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ space: SPACE, delegationToken: TOKEN }),
            });
            expect(res.status).toBe(401);
        });
    });
});
