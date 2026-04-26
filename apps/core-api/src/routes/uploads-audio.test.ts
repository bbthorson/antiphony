import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `POST /api/v1/uploads/audio`.
 *
 * Auth-gated. Multipart upload → StorageService.uploadFile → returns
 * `{ audioUrl }`. Validates mime type allowlist and size cap.
 */

vi.mock('../services/core-services-firebase.js', () => ({
    StorageService: { uploadFile: vi.fn() },
    feedService: {},
    userService: {},
    promptService: {},
    replyService: {},
    organizationService: {},
    firebaseCoreServices: {},
}));

vi.mock('../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

vi.mock('../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: () => ({ doc: () => ({}) }),
        runTransaction: async (fn: (t: unknown) => Promise<boolean>) =>
            fn({
                get: async () => ({ exists: false, data: () => undefined }),
                set: () => undefined,
                update: () => undefined,
            }),
    }),
    getAdmin: () => ({
        firestore: { Timestamp: { fromMillis: (ms: number) => ({ _ms: ms }) } },
    }),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../app.js');
const { StorageService } = await import('../services/core-services-firebase.js');
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

function makeFormData(file: File | null): FormData {
    const fd = new FormData();
    if (file) fd.append('file', file);
    return fd;
}

describe('POST /api/v1/uploads/audio', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without Authorization', async () => {
        const res = await app().request('/api/v1/uploads/audio', {
            method: 'POST',
            body: makeFormData(new File([new Uint8Array(10)], 'a.m4a', { type: 'audio/m4a' })),
        });
        expect(res.status).toBe(401);
    });

    it('400s when no "file" field is present', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'uploader-1' });

        const res = await app().request('/api/v1/uploads/audio', {
            method: 'POST',
            headers: { authorization: 'Bearer ok' },
            body: makeFormData(null),
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.message).toContain('Missing "file"');
    });

    it('400s when mime type is not in the allowlist', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'uploader-2' });

        const res = await app().request('/api/v1/uploads/audio', {
            method: 'POST',
            headers: { authorization: 'Bearer ok' },
            body: makeFormData(
                new File([new Uint8Array(10)], 'evil.exe', { type: 'application/octet-stream' }),
            ),
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.message).toContain('Unsupported audio type');
    });

    it('400s when file exceeds 25MB', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'uploader-3' });
        // 26 MB of zeros — over the 25 MB cap.
        const big = new Uint8Array(26 * 1024 * 1024);

        const res = await app().request('/api/v1/uploads/audio', {
            method: 'POST',
            headers: { authorization: 'Bearer ok' },
            body: makeFormData(new File([big], 'big.m4a', { type: 'audio/m4a' })),
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.message).toContain('too large');
    });

    it('uploads to a uid-scoped path and returns the audioUrl', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'uploader-4' });
        vi.mocked(StorageService.uploadFile).mockResolvedValue('https://cdn/example.m4a');

        const res = await app().request('/api/v1/uploads/audio', {
            method: 'POST',
            headers: { authorization: 'Bearer ok' },
            body: makeFormData(
                new File([new Uint8Array(100)], 'clip.m4a', { type: 'audio/m4a' }),
            ),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ audioUrl: 'https://cdn/example.m4a' });

        expect(vi.mocked(StorageService.uploadFile)).toHaveBeenCalledTimes(1);
        const [bufferArg, pathArg, mimeArg] = vi.mocked(StorageService.uploadFile).mock.calls[0];
        expect(Buffer.isBuffer(bufferArg)).toBe(true);
        expect(pathArg).toMatch(/^audio\/uploader-4\/\d+-[0-9a-f-]{36}\.m4a$/);
        expect(mimeArg).toBe('audio/m4a');
    });
});
