import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceError } from 'shared/errors';
import type { RemotePostView } from 'shared/types/remote-posts';
import type { RemotePostRow } from '@antiphony/core/ports/remote-posts-dependencies';

/**
 * Route tests for the remote-post XRPC queries: `listRemotePosts` and
 * `getRemotePosts`. The service is mocked; these cover the adapter's part:
 * parameters in, the atproto list shape out, and the XRPC error dialect. The
 * service's own rules are in packages/core, and the query in the Postgres suite.
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

const remotePostService = { list: vi.fn(), getMany: vi.fn(), hydrate: vi.fn() };

vi.mock('../../../composition.js', () => ({
    servicesFor: () => ({
        remotePostService,
        rateLimitStore: { hit: async () => 'under' as const },
    }),
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

beforeEach(() => {
    for (const fn of Object.values(remotePostService)) fn.mockReset();
    remotePostService.hydrate.mockImplementation(async (_o: string, rows: RemotePostRow[]) => rows.map((r) => view(r.uri)));
});

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
