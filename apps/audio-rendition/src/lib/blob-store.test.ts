import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const awsFetch = vi.fn();
const awsClientCtor = vi.fn();

vi.mock('aws4fetch', () => ({
    AwsClient: class MockAwsClient {
        constructor(opts: unknown) {
            awsClientCtor(opts);
        }
        fetch = awsFetch;
    },
}));

const ENV_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'ANTIPHONY_R2_BUCKET'] as const;

function clearR2Env() {
    for (const k of ENV_KEYS) delete process.env[k];
}

function setValidR2Env(bucket?: string) {
    process.env.R2_ACCOUNT_ID = 'acct-123';
    process.env.R2_ACCESS_KEY_ID = 'key-abc';
    process.env.R2_SECRET_ACCESS_KEY = 'secret-xyz';
    if (bucket !== undefined) process.env.ANTIPHONY_R2_BUCKET = bucket;
}

beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    clearR2Env();
});

afterEach(() => {
    clearR2Env();
});

describe('r2Config', () => {
    it('reports all missing variables when unconfigured', async () => {
        const { r2Config } = await import('./blob-store.js');

        expect(r2Config()).toEqual({
            missing: ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
        });
    });

    it('treats whitespace-only env values as missing', async () => {
        process.env.R2_ACCOUNT_ID = '   ';
        process.env.R2_ACCESS_KEY_ID = 'key-abc';
        process.env.R2_SECRET_ACCESS_KEY = '\t';
        const { r2Config } = await import('./blob-store.js');

        expect(r2Config()).toEqual({
            missing: ['R2_ACCOUNT_ID', 'R2_SECRET_ACCESS_KEY'],
        });
    });

    it('returns resolved config with default bucket when ANTIPHONY_R2_BUCKET is unset', async () => {
        setValidR2Env();
        const { r2Config } = await import('./blob-store.js');

        expect(r2Config()).toEqual({
            config: {
                accountId: 'acct-123',
                accessKeyId: 'key-abc',
                secretAccessKey: 'secret-xyz',
                bucket: 'antiphony-r2-bucket',
            },
        });
    });

    it('uses ANTIPHONY_R2_BUCKET when set', async () => {
        setValidR2Env('custom-bucket');
        const { r2Config } = await import('./blob-store.js');

        expect(r2Config().config?.bucket).toBe('custom-bucket');
    });
});

describe('blobStore', () => {
    it('fails closed when R2 credentials are missing', async () => {
        const { blobStore } = await import('./blob-store.js');

        await expect(blobStore.read('blobs/voxpop/cid')).rejects.toThrow(
            '[blob-store] R2 is not configured: missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY',
        );
        expect(awsClientCtor).not.toHaveBeenCalled();
    });

    it('constructs SigV4 client once (memoised) with service s3 and region auto', async () => {
        setValidR2Env();
        awsFetch.mockImplementation(() => Promise.resolve(new Response(new Uint8Array([1, 2]), { status: 200 })));
        const { blobStore } = await import('./blob-store.js');

        await blobStore.read('blobs/voxpop/cid1');
        await blobStore.read('blobs/voxpop/cid2');

        expect(awsClientCtor).toHaveBeenCalledTimes(1);
        expect(awsClientCtor).toHaveBeenCalledWith({
            accessKeyId: 'key-abc',
            secretAccessKey: 'secret-xyz',
            service: 's3',
            region: 'auto',
        });
    });

    it('read() returns Buffer on 200, null on 404, and throws on non-OK', async () => {
        setValidR2Env('my-bucket');
        const { blobStore } = await import('./blob-store.js');

        awsFetch.mockResolvedValueOnce(new Response(new Uint8Array([65, 66, 67]), { status: 200 }));
        const bytes = await blobStore.read('blobs/voxpop/bafy123');
        expect(bytes?.equals(Buffer.from('ABC'))).toBe(true);
        expect(awsFetch).toHaveBeenCalledWith(
            'https://acct-123.r2.cloudflarestorage.com/my-bucket/blobs/voxpop/bafy123',
        );

        awsFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
        expect(await blobStore.read('blobs/voxpop/missing')).toBeNull();

        awsFetch.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
        await expect(blobStore.read('blobs/voxpop/denied')).rejects.toThrow(
            '[blob-store] read failed (403) for blobs/voxpop/denied',
        );
    });

    it('head() returns content-length on 200, 0 on missing/invalid header, null on 404, and throws on error', async () => {
        setValidR2Env();
        const { blobStore } = await import('./blob-store.js');

        awsFetch.mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'content-length': '4096' } }));
        expect(await blobStore.head('renditions/voxpop/cid.mp3')).toBe(4096);
        expect(awsFetch).toHaveBeenCalledWith(
            'https://acct-123.r2.cloudflarestorage.com/antiphony-r2-bucket/renditions/voxpop/cid.mp3',
            { method: 'HEAD' },
        );

        awsFetch.mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'content-length': 'not-a-number' } }));
        expect(await blobStore.head('renditions/voxpop/bad-len.mp3')).toBe(0);

        awsFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
        expect(await blobStore.head('renditions/voxpop/missing.mp3')).toBeNull();

        awsFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
        await expect(blobStore.head('renditions/voxpop/err.mp3')).rejects.toThrow(
            '[blob-store] head failed (500) for renditions/voxpop/err.mp3',
        );
    });

    it('write() sends PUT with content-type and bytes, encoding path segments while preserving slashes', async () => {
        setValidR2Env();
        const { blobStore } = await import('./blob-store.js');

        awsFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
        await blobStore.write('renditions/app with space/cid#1.mp3', Buffer.from([1, 2, 3]), 'audio/mpeg');

        expect(awsFetch).toHaveBeenCalledWith(
            'https://acct-123.r2.cloudflarestorage.com/antiphony-r2-bucket/renditions/app%20with%20space/cid%231.mp3',
            expect.objectContaining({
                method: 'PUT',
                headers: { 'content-type': 'audio/mpeg' },
            }),
        );

        awsFetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
        await expect(blobStore.write('renditions/a/b.mp3', Buffer.from([1]), 'audio/mpeg')).rejects.toThrow(
            '[blob-store] write failed (503) for renditions/a/b.mp3',
        );
    });
});
