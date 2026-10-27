import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Route tests for the delete surface (specs/deletion.md § 4): `DELETE
 * /api/v1/posts/{postId}`, the 410 on a deleted post, `POST
 * /api/v1/authors/{authorId}/erase` and `DELETE /api/v1/spaces/{type}/{skey}`.
 * The services are mocked: what is deleted, and how, is covered by
 * `post-deletion.test.ts` in `packages/core` and the Postgres suite.
 */

const rateLimitKeys: string[] = [];

const postDeletionService = {
    deletePost: vi.fn(),
    eraseAuthor: vi.fn(),
    getDeletedPost: vi.fn(),
};
const audioPostService = { getPostView: vi.fn() };
const spaceService = { deleteSpace: vi.fn() };

vi.mock('../../../composition.js', () => ({
    servicesFor: () => ({
        postDeletionService,
        audioPostService,
        spaceService,
        rateLimitStore: {
            hit: async (key: string) => {
                rateLimitKeys.push(key);
                return 'under';
            },
        },
    }),
}));

const SERVICE_TOKEN = 'svc-tok-abcdefghijklmnopqrstuvwxyz012345';
process.env.LOG_LEVEL = 'silent';
process.env.ANTIPHONY_APP_TOKENS = `test-app:${SERVICE_TOKEN}`;

const { app } = await import('../../../app.js');
const { seedValidatedPins } = await import('../../../lib/testing/seed-pins.js');
await seedValidatedPins({ 'test-app': 'did:web:test-app.example' });

const auth = (actor?: string): Record<string, string> => ({
    Authorization: `Bearer ${SERVICE_TOKEN}`,
    ...(actor ? { 'X-Antiphony-Acting-Actor': actor } : {}),
});

const RESULT = {
    status: 'deleted' as const,
    complete: true,
    deleted: [{ postId: 'p1', uri: 'at://did:web:test-app.example/dev.antiphony.audio.post/p1', kind: 'prompt' as const }],
    kept: [],
};

beforeEach(() => {
    rateLimitKeys.length = 0;
    postDeletionService.getDeletedPost.mockResolvedValue(null);
});

describe('DELETE /api/v1/posts/:postId', () => {
    it('deletes with the default `replies` policy and needs no acting actor', async () => {
        postDeletionService.deletePost.mockResolvedValue(RESULT);

        const res = await app().request('/api/v1/posts/p1', { method: 'DELETE', headers: auth() });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, data: RESULT });
        expect(postDeletionService.deletePost).toHaveBeenCalledWith('test-app', 'p1', 'delete');
    });

    it('passes `replies` through', async () => {
        postDeletionService.deletePost.mockResolvedValue({ ...RESULT, kept: [{ postId: 'r1', uri: 'at://x/y/r1' }] });

        const res = await app().request('/api/v1/posts/p1?replies=keep-with-did', { method: 'DELETE', headers: auth('u1') });

        expect(res.status).toBe(200);
        expect(postDeletionService.deletePost).toHaveBeenCalledWith('test-app', 'p1', 'keep-with-did');
    });

    it('rejects an unknown `replies`', async () => {
        const res = await app().request('/api/v1/posts/p1?replies=orphan', { method: 'DELETE', headers: auth() });

        expect(res.status).toBe(400);
        expect(postDeletionService.deletePost).not.toHaveBeenCalled();
    });

    it('404s a post the tenant never had', async () => {
        postDeletionService.deletePost.mockResolvedValue(null);

        const res = await app().request('/api/v1/posts/nope', { method: 'DELETE', headers: auth() });

        expect(res.status).toBe(404);
    });

    it('requires the service token', async () => {
        const res = await app().request('/api/v1/posts/p1', { method: 'DELETE' });

        expect(res.status).toBe(401);
        expect(postDeletionService.deletePost).not.toHaveBeenCalled();
    });

    it('rate-limits per acting actor within the tenant', async () => {
        postDeletionService.deletePost.mockResolvedValue(RESULT);

        await app().request('/api/v1/posts/p1', { method: 'DELETE', headers: auth('listener-1') });

        expect(rateLimitKeys).toContain('ratelimit_burst_test-app:listener-1');
    });
});

describe('GET /api/v1/posts/:postId after a delete', () => {
    it('answers 410 POST_DELETED for a post in the ledger', async () => {
        audioPostService.getPostView.mockResolvedValue(null);
        postDeletionService.getDeletedPost.mockResolvedValue({ postId: 'p1', uri: 'at://x', kind: 'prompt', deletedAt: new Date() });

        const res = await app().request('/api/v1/posts/p1', { headers: auth() });

        expect(res.status).toBe(410);
        expect(await res.json()).toMatchObject({ success: false, error: { code: 'POST_DELETED' } });
        expect(postDeletionService.getDeletedPost).toHaveBeenCalledWith('test-app', 'p1');
    });

    it('still answers 404 for a post never seen', async () => {
        audioPostService.getPostView.mockResolvedValue(null);

        const res = await app().request('/api/v1/posts/nope', { headers: auth() });

        expect(res.status).toBe(404);
    });
});

describe('POST /api/v1/authors/:authorId/erase', () => {
    const PAGE = { complete: false, deleted: RESULT.deleted, kept: [] };

    it('applies the defaults when the body is empty', async () => {
        postDeletionService.eraseAuthor.mockResolvedValue(PAGE);

        const res = await app().request('/api/v1/authors/creator-1/erase', { method: 'POST', headers: auth() });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, data: PAGE });
        expect(postDeletionService.eraseAuthor).toHaveBeenCalledWith('test-app', 'creator-1', 'delete', 100);
    });

    it('takes `replies` and `limit`', async () => {
        postDeletionService.eraseAuthor.mockResolvedValue({ ...PAGE, complete: true });

        const res = await app().request('/api/v1/authors/creator-1/erase', {
            method: 'POST',
            headers: { ...auth(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ replies: 'keep-with-did', limit: 25 }),
        });

        expect(res.status).toBe(200);
        expect(postDeletionService.eraseAuthor).toHaveBeenCalledWith('test-app', 'creator-1', 'keep-with-did', 25);
    });

    it('rejects a limit above 200 and malformed JSON', async () => {
        const tooMany = await app().request('/api/v1/authors/creator-1/erase', {
            method: 'POST',
            headers: { ...auth(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: 500 }),
        });
        const malformed = await app().request('/api/v1/authors/creator-1/erase', {
            method: 'POST',
            headers: { ...auth(), 'Content-Type': 'application/json' },
            body: '{',
        });

        expect(tooMany.status).toBe(400);
        expect(malformed.status).toBe(400);
        expect(postDeletionService.eraseAuthor).not.toHaveBeenCalled();
    });

    it('rate-limits per tenant, whatever actor is asserted', async () => {
        postDeletionService.eraseAuthor.mockResolvedValue(PAGE);

        await app().request('/api/v1/authors/creator-1/erase', { method: 'POST', headers: auth('operator') });

        expect(rateLimitKeys).toContain('ratelimit_burst_test-app');
    });
});

describe('DELETE /api/v1/spaces/:spaceType/:skey', () => {
    const PATH = '/api/v1/spaces/audio.voxpop.space.replies/3kprompt00000a';

    it('reports whether a space was deleted', async () => {
        spaceService.deleteSpace.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

        const first = await app().request(PATH, { method: 'DELETE', headers: auth() });
        const second = await app().request(PATH, { method: 'DELETE', headers: auth() });

        expect(await first.json()).toEqual({ success: true, data: { deleted: true } });
        expect(await second.json()).toEqual({ success: true, data: { deleted: false } });
        expect(spaceService.deleteSpace).toHaveBeenCalledWith('test-app', {
            type: 'audio.voxpop.space.replies',
            skey: '3kprompt00000a',
        });
    });

    it('maps a space that still holds posts to 409 SPACE_NOT_EMPTY', async () => {
        const { SpaceNotEmptyError } = await import('@antiphony/core/services/spaces');
        spaceService.deleteSpace.mockRejectedValue(new SpaceNotEmptyError());

        const res = await app().request(PATH, { method: 'DELETE', headers: auth() });

        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ error: { code: 'SPACE_NOT_EMPTY' } });
    });
});
