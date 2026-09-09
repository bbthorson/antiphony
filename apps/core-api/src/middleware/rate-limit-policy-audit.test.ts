import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../app.js';

const keys: string[] = [];

vi.mock('../composition.js', () => ({
    servicesFor: () => ({
        rateLimitStore: {
            hit: async (key: string) => {
                keys.push(key);
                return 'under' as const;
            },
        },
        audioPostService: {
            getPostView: async () => null,
            getPostsForAuthor: async () => [],
            getReplies: async () => [],
            createPost: async () => ({ id: 'p1', cid: 'bafy123' }),
            setProcessing: async () => null,
        },
        audioUploadService: {
            uploadFile: async () => ({ cid: 'bafy123', mimeType: 'audio/mp4', size: 100 }),
        },
        idempotencyStore: {
            claim: async () => 'claimed' as const,
            release: async () => {},
            settle: async () => {},
        },
        blobStore: {
            put: async () => {},
        },
    }),
}));

vi.mock('../lib/app-did.js', () => ({
    ensureTenantPin: vi.fn(async () => undefined),
    parseAppDids: vi.fn(() => new Map()),
    getValidatedPin: vi.fn(() => null),
    getAppDid: vi.fn(() => 'did:web:voxpop.audio'),
}));

vi.mock('../lib/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    correlationId: () => 'req-123',
}));

const VALID_TOKEN = 'a'.repeat(40);
const CLIENT_IP = '203.0.113.42';

describe('rate limit policy audit — authenticated routes must not key on bare IP', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        keys.length = 0;
        process.env.ANTIPHONY_APP_TOKENS = `voxpop:${VALID_TOKEN}`;
        process.env.CLIENT_IP_SOURCE = 'cf';
        const { resetRateLimitCircuitForTest } = await import('./rate-limit.js');
        resetRateLimitCircuitForTest();
    });

    afterEach(() => {
        delete process.env.CLIENT_IP_SOURCE;
        delete process.env.ANTIPHONY_APP_TOKENS;
    });

    it('asserts GET /api/v1/posts keys with actor and aggregate, never bare IP', async () => {
        const a = app();
        await a.request('/api/v1/posts', {
            headers: {
                authorization: `Bearer ${VALID_TOKEN}`,
                'x-antiphony-acting-actor': 'user-alice',
                'cf-connecting-ip': CLIENT_IP,
            },
        });

        expect(keys).toContain('ratelimit_read_voxpop:user-alice');
        expect(keys).toContain(`ratelimit_readAggregate_${CLIENT_IP}`);
        expect(keys).not.toContain(`ratelimit_read_${CLIENT_IP}`);
    });

    it('asserts GET /api/v1/posts/:id keys with actor and aggregate, never bare IP', async () => {
        const a = app();
        await a.request('/api/v1/posts/p1', {
            headers: {
                authorization: `Bearer ${VALID_TOKEN}`,
                'x-antiphony-acting-actor': 'user-alice',
                'cf-connecting-ip': CLIENT_IP,
            },
        });

        expect(keys).toContain('ratelimit_read_voxpop:user-alice');
        expect(keys).toContain(`ratelimit_readAggregate_${CLIENT_IP}`);
        expect(keys).not.toContain(`ratelimit_read_${CLIENT_IP}`);
    });

    it('asserts viewer-less GET /api/v1/posts/:id keys on originAppId, never bare IP', async () => {
        const a = app();
        await a.request('/api/v1/posts/p1', {
            headers: {
                authorization: `Bearer ${VALID_TOKEN}`,
                'cf-connecting-ip': CLIENT_IP,
            },
        });

        expect(keys).toContain('ratelimit_read_voxpop');
        expect(keys).toContain(`ratelimit_readAggregate_${CLIENT_IP}`);
        expect(keys).not.toContain(`ratelimit_read_${CLIENT_IP}`);
    });

    it('asserts XRPC query routes key with actor and aggregate, never bare IP', async () => {
        const a = app();
        await a.request('/xrpc/dev.antiphony.audio.getPost?id=p1', {
            headers: {
                authorization: `Bearer ${VALID_TOKEN}`,
                'x-antiphony-acting-actor': 'user-alice',
                'cf-connecting-ip': CLIENT_IP,
            },
        });

        expect(keys).toContain('ratelimit_read_voxpop:user-alice');
        expect(keys).toContain(`ratelimit_readAggregate_${CLIENT_IP}`);
        expect(keys).not.toContain(`ratelimit_read_${CLIENT_IP}`);
    });

    it('asserts XRPC procedure routes key with actor and aggregate, never bare IP', async () => {
        const a = app();
        await a.request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${VALID_TOKEN}`,
                'x-antiphony-acting-actor': 'user-alice',
                'cf-connecting-ip': CLIENT_IP,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                text: 'hello',
                embed: {
                    $type: 'dev.antiphony.embed.audio',
                    audio: {
                        $type: 'blob',
                        ref: { $link: 'bafy123' },
                        mimeType: 'audio/mp4',
                        size: 1000,
                    },
                },
            }),
        });

        expect(keys).toContain('ratelimit_write_voxpop:user-alice');
        expect(keys).toContain(`ratelimit_writeAggregate_${CLIENT_IP}`);
        expect(keys).not.toContain(`ratelimit_write_${CLIENT_IP}`);
    });

    it('asserts audio upload keys with actor, never bare IP', async () => {
        const a = app();
        const formData = new FormData();
        formData.append('file', new Blob([new Uint8Array(100)], { type: 'audio/mp4' }), 'audio.mp4');

        await a.request('/api/v1/audio/upload', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${VALID_TOKEN}`,
                'x-antiphony-acting-actor': 'user-alice',
                'cf-connecting-ip': CLIENT_IP,
            },
            body: formData,
        });

        expect(keys).toContain('ratelimit_hourly_voxpop:user-alice');
        expect(keys).toContain(`ratelimit_writeAggregate_${CLIENT_IP}`);
        expect(keys).not.toContain(`ratelimit_hourly_${CLIENT_IP}`);
    });
});
