import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `POST /api/v1/audio/upload-pending`.
 *
 * Anonymous (rate-limited) embed upload → StorageService.uploadFile +
 * pending_uploads doc → returns the standard envelope
 * `{ success: true, data: { pendingId } }`. The embed client
 * (ReplyDot.submitPendingEmbed) unwraps `data.pendingId`, so the envelope
 * shape is load-bearing — a bare `{ pendingId }` silently breaks the
 * top-frame handoff.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    StorageService: { uploadFile: vi.fn() },
    feedService: {},
    userService: {},
    promptService: { getPromptData: vi.fn() },
    replyService: {},
    organizationService: {},
    firebaseCoreServices: {},
}));

vi.mock('../../../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: () => ({
            doc: () => ({
                set: async () => undefined,
                get: async () => ({ exists: false, data: () => undefined }),
            }),
        }),
        // Rate-limit middleware runs the counter in a transaction; an
        // empty/non-existent doc reads as under-limit.
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

const { app } = await import('../../../app.js');
const { StorageService, promptService } = await import(
    '../../outbound/firebase/core-services-firebase.js'
);

function makeFormData(opts: { file?: File | null; promptId?: string | null }): FormData {
    const fd = new FormData();
    if (opts.file) fd.append('file', opts.file);
    if (opts.promptId != null) fd.append('promptId', opts.promptId);
    return fd;
}

// A blob over the 512-byte MIN_SIZE floor.
const goodAudio = () =>
    new File([new Uint8Array(1024)], 'reply.webm', { type: 'audio/webm' });

describe('POST /api/v1/audio/upload-pending', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('400s when no "file" field is present', async () => {
        const res = await app().request('/api/v1/audio/upload-pending', {
            method: 'POST',
            body: makeFormData({ promptId: 'prompt-1' }),
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toContain('Missing "file"');
    });

    it('400s when mime type is not in the allowlist', async () => {
        const res = await app().request('/api/v1/audio/upload-pending', {
            method: 'POST',
            body: makeFormData({
                file: new File([new Uint8Array(1024)], 'evil.exe', {
                    type: 'application/octet-stream',
                }),
                promptId: 'prompt-1',
            }),
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toContain('Unsupported audio type');
    });

    it('404s when the prompt is not live', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { record: { id: 'prompt-1', status: 'draft' } } as any,
        );

        const res = await app().request('/api/v1/audio/upload-pending', {
            method: 'POST',
            body: makeFormData({ file: goodAudio(), promptId: 'prompt-1' }),
        });

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error.message).toContain('not accepting replies');
    });

    it('returns the standard envelope with a pendingId on success', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { record: { id: 'prompt-1', status: 'live' } } as any,
        );
        vi.mocked(StorageService.uploadFile).mockResolvedValue('https://cdn/pending.webm');

        const res = await app().request('/api/v1/audio/upload-pending', {
            method: 'POST',
            body: makeFormData({ file: goodAudio(), promptId: 'prompt-1' }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        // Envelope shape — NOT a bare `{ pendingId }`. The embed reads
        // `data.pendingId`.
        expect(body.success).toBe(true);
        expect(typeof body.data.pendingId).toBe('string');
        expect(body.data.pendingId).toMatch(/^pend_/);
        expect(body.pendingId).toBeUndefined();
    });

    it('500s with an error envelope when storage write fails', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { record: { id: 'prompt-1', status: 'live' } } as any,
        );
        vi.mocked(StorageService.uploadFile).mockRejectedValue(new Error('storage down'));

        const res = await app().request('/api/v1/audio/upload-pending', {
            method: 'POST',
            body: makeFormData({ file: goodAudio(), promptId: 'prompt-1' }),
        });

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.message).toContain('Upload failed');
    });
});
