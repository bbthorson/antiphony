import { describe, it, expect, vi } from 'vitest';
import { createAntiphonyClient, AntiphonyClientError } from './client';
import { SERVICE_AUTH_HEADER } from './service-auth';

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

describe('createAntiphonyClient', () => {
    it('wires service token, acting actor, actor DID, requestId, and signed service-auth headers', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonRes({ uri: 'at://x/y/1', cid: 'bafy1' }));
        const signer = vi.fn().mockResolvedValue('signed.jwt.token');
        const client = createAntiphonyClient({
            baseUrl: 'https://api.antiphony.dev/',
            serviceToken: 'svc-tok',
            defaultActor: 'user-1',
            defaultActorDid: 'did:plc:user1',
            signServiceAuth: signer,
            fetch: fetchMock,
        });

        const res = await client.createPost(
            { text: 'hello' },
            { idempotencyKey: 'idem-1', requestId: 'req-9' },
        );

        expect(res).toEqual({ uri: 'at://x/y/1', cid: 'bafy1' });
        expect(signer).toHaveBeenCalledWith({ kind: 'xrpc', lxm: 'dev.antiphony.audio.createPost' });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.antiphony.dev/xrpc/dev.antiphony.audio.createPost',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    authorization: 'Bearer svc-tok',
                    'x-antiphony-acting-actor': 'user-1',
                    'x-antiphony-acting-actor-did': 'did:plc:user1',
                    'idempotency-key': 'idem-1',
                    'x-request-id': 'req-9',
                    [SERVICE_AUTH_HEADER]: 'signed.jwt.token',
                    'content-type': 'application/json',
                }),
                body: JSON.stringify({ text: 'hello' }),
            }),
        );
    });

    it('serializes query parameters including repeated uris array on getRemotePosts', async () => {
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonRes({ posts: [] })));
        const client = createAntiphonyClient({
            baseUrl: 'https://api.antiphony.dev',
            serviceToken: 'svc-tok',
            fetch: fetchMock,
        });

        await client.getRemotePosts(['at://did:plc:a/c/1', 'at://did:plc:b/c/2']);
        const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
        expect(calledUrl.pathname).toBe('/xrpc/dev.antiphony.audio.getRemotePosts');
        expect(calledUrl.searchParams.getAll('uris')).toEqual(['at://did:plc:a/c/1', 'at://did:plc:b/c/2']);

        await client.listPosts({ limit: 10, kind: 'prompt', cursor: 'c1' }, { actor: 'u1' });
        const listUrl = new URL(fetchMock.mock.calls[1][0] as string);
        expect(listUrl.pathname).toBe('/xrpc/dev.antiphony.audio.listPosts');
        expect(listUrl.searchParams.get('limit')).toBe('10');
        expect(listUrl.searchParams.get('kind')).toBe('prompt');
        expect(listUrl.searchParams.get('cursor')).toBe('c1');
    });

    it('uploads raw audio bytes with optional space query params and Idempotency-Key', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            jsonRes({
                blob: { $type: 'blob', ref: { $link: 'bafy1' }, mimeType: 'audio/webm', size: 3 },
                space: { type: 'game.bardcast.space.campaign', skey: 'c1' },
            }),
        );
        const client = createAntiphonyClient({
            baseUrl: 'https://api.antiphony.dev',
            serviceToken: 'svc-tok',
            fetch: fetchMock,
        });

        const out = await client.uploadAudio(
            {
                bytes: new Uint8Array([1, 2, 3]),
                contentType: 'audio/webm',
                spaceType: 'game.bardcast.space.campaign',
                skey: 'c1',
            },
            { actor: 'u1', idempotencyKey: 'up-1' },
        );

        expect(out.blob.ref.$link).toBe('bafy1');
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const parsed = new URL(url);
        expect(parsed.pathname).toBe('/xrpc/dev.antiphony.audio.uploadAudio');
        expect(parsed.searchParams.get('spaceType')).toBe('game.bardcast.space.campaign');
        expect(parsed.searchParams.get('skey')).toBe('c1');
        expect((init.headers as Record<string, string>)['content-type']).toBe('audio/webm');
        expect((init.headers as Record<string, string>)['idempotency-key']).toBe('up-1');
    });

    it('supports public calls without a serviceToken (describeServer, getPost)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            jsonRes({ service: 'antiphony-core-api', version: '0.10.9', status: 'ok' }),
        );
        const client = createAntiphonyClient({
            baseUrl: 'https://api.antiphony.dev',
            fetch: fetchMock,
        });

        const info = await client.describeServer();
        expect(info.status).toBe('ok');
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    });

    it('throws AntiphonyClientError with XRPC error symbol, status, message, and X-Request-ID', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            jsonRes(
                { error: 'PostDeleted', message: 'Post deleted: p1' },
                410,
                { 'x-request-id': 'req-410' },
            ),
        );
        const client = createAntiphonyClient({
            baseUrl: 'https://api.antiphony.dev',
            serviceToken: 'svc-tok',
            fetch: fetchMock,
        });

        await expect(client.getPost('p1')).rejects.toSatisfy((err: unknown) => {
            expect(err).toBeInstanceOf(AntiphonyClientError);
            const e = err as AntiphonyClientError;
            expect(e.status).toBe(410);
            expect(e.code).toBe('PostDeleted');
            expect(e.message).toBe('Post deleted: p1');
            expect(e.requestId).toBe('req-410');
            return true;
        });
    });

    it('covers deletePost, eraseAuthor, getStats, and remote-post procedures', async () => {
        const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonRes({ ok: true })));
        const client = createAntiphonyClient({
            baseUrl: 'https://api.antiphony.dev',
            serviceToken: 'svc-tok',
            fetch: fetchMock,
        });

        await client.deletePost({ id: 'p1', replies: 'delete' });
        await client.eraseAuthor({ authorId: 'u1', replies: 'keep', limit: 50 });
        await client.getStats();
        await client.registerPost({ uri: 'at://did:plc:a/dev.antiphony.audio.post/1', cid: 'bafy1' });
        await client.unregisterPost({ uri: 'at://did:plc:a/dev.antiphony.audio.post/1' });

        const paths = fetchMock.mock.calls.map((c) => new URL(c[0] as string).pathname);
        expect(paths).toEqual([
            '/xrpc/dev.antiphony.audio.deletePost',
            '/xrpc/dev.antiphony.audio.eraseAuthor',
            '/xrpc/dev.antiphony.tenant.getStats',
            '/xrpc/dev.antiphony.audio.registerPost',
            '/xrpc/dev.antiphony.audio.unregisterPost',
        ]);
    });
});
