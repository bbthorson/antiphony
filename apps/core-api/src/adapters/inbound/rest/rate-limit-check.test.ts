import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for `POST /api/v1/system/rate-limit/check`. System-auth (shared
 * secret bearer) ONLY. Apps/web's rate-limit shim calls this endpoint so
 * it doesn't have to depend on `firebase-admin`. PR-F3b stage 1.
 *
 * We don't unit-test the Firestore transaction directly here — the
 * middleware tests (and the live Firestore emulator runs in CI) cover
 * that path. These tests verify the endpoint contract: system-auth gate,
 * body validation, allowed/limited mapping to envelope shape.
 */

// Mock the rate-limit check function so we control allowed/denied paths
// without booting Firestore. Real Firestore behavior is exercised by
// the middleware tests under rate-limit logic.
vi.mock('../../../middleware/rate-limit.js', async () => {
    return {
        checkRateLimit: vi.fn(),
        // Keep the middleware factory around — app.ts imports it for
        // every route's rate-limit guard, so we need a no-op stub.
        rateLimit: () => async (_: unknown, next: () => Promise<void>) => next(),
        RATE_LIMITS: {
            write: { limit: 10, windowMs: 60_000 },
            read: { limit: 60, windowMs: 60_000 },
            auth: { limit: 5, windowMs: 60_000 },
            hourly: { limit: 20, windowMs: 60 * 60_000 },
            sensitive: { limit: 5, windowMs: 60 * 60_000 },
            burst: { limit: 20, windowMs: 60_000 },
            standard: { limit: 10, windowMs: 60_000 },
        },
    };
});

// Other firebase-admin-touching mocks — same pattern as system-replies.test.ts.
vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    replyService: {},
    callForwardingService: {},
    userService: {},
    organizationService: {},
    promptService: {},
    feedService: {},
    hydrationService: {},
    rssService: {},
    StorageService: {},
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
const { checkRateLimit } = await import('../../../middleware/rate-limit.js');

const SYSTEM_TOKEN = 'test-system-token-rate-limit-1234';
const authHeader = { authorization: `Bearer ${SYSTEM_TOKEN}` };

const validBody = {
    key: 'ratelimit_203.0.113.5',
    limit: 10,
    windowMs: 60_000,
    message: 'Too many requests',
};

function postCheck(body: unknown, headers: Record<string, string> = {}) {
    return app().request('/api/v1/system/rate-limit/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader, ...headers },
        body: JSON.stringify(body),
    });
}

describe('POST /api/v1/system/rate-limit/check', () => {
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

    it('returns 200 with allowed:true when checkRateLimit allows', async () => {
        vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true });
        const res = await postCheck(validBody);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
            success: true,
            data: { allowed: true },
        });
        // Endpoint passes the validated options through unchanged.
        expect(checkRateLimit).toHaveBeenCalledWith(
            validBody.key,
            { limit: validBody.limit, windowMs: validBody.windowMs, message: validBody.message },
            expect.any(String), // requestId
        );
    });

    it('returns 429 with RATE_LIMITED code when checkRateLimit denies', async () => {
        vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false });
        const res = await postCheck(validBody);
        expect(res.status).toBe(429);
        const body = await res.json();
        expect(body).toMatchObject({
            success: false,
            error: { message: validBody.message, code: 'RATE_LIMITED' },
        });
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('falls back to default message when caller omits it on the 429', async () => {
        vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false });
        const { message: _omitted, ...bodyWithoutMessage } = validBody;
        void _omitted;
        const res = await postCheck(bodyWithoutMessage);
        expect(res.status).toBe(429);
        const body = await res.json();
        expect(body.error.message).toBe('Too many requests');
    });

    it('returns 401 when system-auth header is missing', async () => {
        const res = await app().request('/api/v1/system/rate-limit/check', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validBody),
        });
        expect(res.status).toBe(401);
        // Must not have called the check — system-auth gates first.
        expect(checkRateLimit).not.toHaveBeenCalled();
    });

    it('returns 401 on wrong system-auth token', async () => {
        const res = await app().request('/api/v1/system/rate-limit/check', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: 'Bearer wrong-secret',
            },
            body: JSON.stringify(validBody),
        });
        expect(res.status).toBe(401);
        expect(checkRateLimit).not.toHaveBeenCalled();
    });

    it('returns 400 on invalid JSON body', async () => {
        const res = await app().request('/api/v1/system/rate-limit/check', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeader },
            body: 'not-json',
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.message).toBe('Invalid JSON body');
    });

    it('returns 400 with Zod issues on missing required fields', async () => {
        const res = await postCheck({ key: 'ratelimit_x' /* limit + windowMs missing */ });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.message).toBe('Invalid request body');
        expect(Array.isArray(body.error.issues)).toBe(true);
    });

    it('rejects windowMs above the 24h ceiling', async () => {
        const res = await postCheck({
            ...validBody,
            windowMs: 25 * 60 * 60 * 1000,
        });
        expect(res.status).toBe(400);
    });

    it('rejects empty key', async () => {
        const res = await postCheck({ ...validBody, key: '' });
        expect(res.status).toBe(400);
    });

    it('rejects key containing a slash (Firestore doc-id legality)', async () => {
        const res = await postCheck({ ...validBody, key: 'ratelimit_foo/bar' });
        expect(res.status).toBe(400);
        expect(checkRateLimit).not.toHaveBeenCalled();
    });

    it('rejects reserved keys `.` and `..`', async () => {
        for (const reserved of ['.', '..']) {
            const res = await postCheck({ ...validBody, key: reserved });
            expect(res.status).toBe(400);
        }
        expect(checkRateLimit).not.toHaveBeenCalled();
    });

    it('propagates inbound X-Request-ID into the requestId arg passed to checkRateLimit', async () => {
        vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true });
        const res = await postCheck(validBody, { 'x-request-id': 'trace-rl-1' });
        expect(res.status).toBe(200);
        expect(checkRateLimit).toHaveBeenCalledWith(
            validBody.key,
            expect.any(Object),
            'trace-rl-1',
        );
    });
});
