import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for `POST /api/v1/system/replies`. System-auth (shared-secret
 * bearer) ONLY — NOT user-auth. Used by apps/telephony to attribute a
 * captured reply to a uid the caller has already resolved via the
 * `/api/v1/call-forwarding/by-*` lookup endpoints. PR-E3.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    replyService: {
        createReplyTransaction: vi.fn(),
    },
    callForwardingService: {},
    userService: {},
    organizationService: {},
    promptService: {},
    feedService: {},
    hydrationService: {},
    firebaseCoreServices: {},
}));

vi.mock('../../../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
    getAdmin: () => ({}),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../../../app.js');
const { replyService } = await import('../../outbound/firebase/core-services-firebase.js');

const SYSTEM_TOKEN = 'test-system-token-1234567890';
const authHeader = { authorization: `Bearer ${SYSTEM_TOKEN}` };

const validBody = {
    authorUid: 'u-author',
    promptId: 'p-123',
    audioUrl: 'https://storage.googleapis.com/audio/r-789.webm',
};

const sampleReplyView = {
    record: {
        id: 'r-789',
        promptId: 'p-123',
        authorId: 'u-author',
        audioUrl: 'https://storage.googleapis.com/audio/r-789.webm',
        status: 'live' as const,
        createdAt: '2026-05-18T00:00:00Z',
        readBy: [],
    },
    author: { id: 'u-author', handle: 'author', displayName: 'Author' },
    recipient: { id: 'u-author', handle: 'author', displayName: 'Author' },
};

describe('POST /api/v1/system/replies', () => {
    const originalToken = process.env.SYSTEM_AUTH_TOKEN;

    beforeEach(() => {
        vi.resetAllMocks();
        process.env.SYSTEM_AUTH_TOKEN = SYSTEM_TOKEN;
    });

    afterEach(() => {
        if (originalToken === undefined) {
            delete process.env.SYSTEM_AUTH_TOKEN;
        } else {
            process.env.SYSTEM_AUTH_TOKEN = originalToken;
        }
    });

    it('creates the reply and returns the hydrated view', async () => {
        vi.mocked(replyService.createReplyTransaction).mockResolvedValue(sampleReplyView as never);

        const res = await app().request('/api/v1/system/replies', {
            method: 'POST',
            headers: { ...authHeader, 'content-type': 'application/json' },
            body: JSON.stringify(validBody),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.record.id).toBe('r-789');
        expect(replyService.createReplyTransaction).toHaveBeenCalledWith('u-author', {
            promptId: 'p-123',
            audioUrl: validBody.audioUrl,
        });
    });

    it('returns 401 without a bearer header', async () => {
        const res = await app().request('/api/v1/system/replies', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validBody),
        });
        expect(res.status).toBe(401);
        expect(replyService.createReplyTransaction).not.toHaveBeenCalled();
    });

    it('returns 401 with a non-matching bearer token', async () => {
        const res = await app().request('/api/v1/system/replies', {
            method: 'POST',
            headers: {
                authorization: 'Bearer wrong-token',
                'content-type': 'application/json',
            },
            body: JSON.stringify(validBody),
        });
        expect(res.status).toBe(401);
        expect(replyService.createReplyTransaction).not.toHaveBeenCalled();
    });

    it('returns 503 if SYSTEM_AUTH_TOKEN env var is unset', async () => {
        delete process.env.SYSTEM_AUTH_TOKEN;

        const res = await app().request('/api/v1/system/replies', {
            method: 'POST',
            headers: { ...authHeader, 'content-type': 'application/json' },
            body: JSON.stringify(validBody),
        });
        expect(res.status).toBe(503);
        expect(replyService.createReplyTransaction).not.toHaveBeenCalled();
    });

    it('returns 400 on invalid JSON body', async () => {
        const res = await app().request('/api/v1/system/replies', {
            method: 'POST',
            headers: { ...authHeader, 'content-type': 'application/json' },
            body: 'not json',
        });
        expect(res.status).toBe(400);
        expect(replyService.createReplyTransaction).not.toHaveBeenCalled();
    });

    it('returns 400 when authorUid is missing', async () => {
        const res = await app().request('/api/v1/system/replies', {
            method: 'POST',
            headers: { ...authHeader, 'content-type': 'application/json' },
            body: JSON.stringify({ promptId: 'p-123', audioUrl: validBody.audioUrl }),
        });
        expect(res.status).toBe(400);
        expect(replyService.createReplyTransaction).not.toHaveBeenCalled();
    });

    it('returns 400 when audioUrl is not a URL', async () => {
        const res = await app().request('/api/v1/system/replies', {
            method: 'POST',
            headers: { ...authHeader, 'content-type': 'application/json' },
            body: JSON.stringify({ ...validBody, audioUrl: 'not-a-url' }),
        });
        expect(res.status).toBe(400);
        expect(replyService.createReplyTransaction).not.toHaveBeenCalled();
    });
});
