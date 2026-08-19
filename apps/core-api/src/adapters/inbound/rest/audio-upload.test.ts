import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `POST /api/v1/audio/upload`.
 *
 * Auth-gated. Multipart upload → content CID → uploadFile at
 * the CID-derived path → returns `{ blob }` (the canonical AT Protocol blob
 * ref). Validates mime type allowlist and size cap.
 */

const uploadFile = vi.fn();
vi.mock('../../../composition.js', () => ({
    servicesFor: () => ({
        storage: { uploadFile },
    // The rate-limit middleware resolves its store from here now, rather
    // than defaulting to the Firestore binding. Under limit on every hit:
    // these suites assert route behaviour, not rate-limit policy (that is
    // middleware/rate-limit.test.ts).
    rateLimitStore: { hit: async () => 'under' as const },
    }),
}));

// The uploader authenticates as the application `antiphony` (the default
// tenancy — these tests assert the `blobs/antiphony/...` storage path) via a
// service token, asserting an acting actor with X-Antiphony-Acting-Actor.
const SERVICE_TOKEN = 'svc-tok-abcdefghijklmnopqrstuvwxyz012345';
process.env.LOG_LEVEL = 'silent';
process.env.ANTIPHONY_APP_TOKENS = `antiphony:${SERVICE_TOKEN}`;

const { app } = await import('../../../app.js');
// Every gated route now proves its tenant's app-DID custody in the auth
// middleware — the Workers replacement for the boot gate. Seed the snapshot
// so these cases keep testing their own subject rather than a missing pin.
const { seedValidatedPins } = await import('../../../lib/testing/seed-pins.js');
await seedValidatedPins({ 'antiphony': 'did:web:antiphony.example' });


const AUTH = {
    authorization: `Bearer ${SERVICE_TOKEN}`,
    'x-antiphony-acting-actor': 'uploader',
};

function makeFormData(file: File | null): FormData {
    const fd = new FormData();
    if (file) fd.append('file', file);
    return fd;
}

describe('POST /api/v1/audio/upload', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without Authorization', async () => {
        const res = await app().request('/api/v1/audio/upload', {
            method: 'POST',
            body: makeFormData(new File([new Uint8Array(10)], 'a.m4a', { type: 'audio/m4a' })),
        });
        expect(res.status).toBe(401);
    });

    it('400s when no "file" field is present', async () => {
        const res = await app().request('/api/v1/audio/upload', {
            method: 'POST',
            headers: AUTH,
            body: makeFormData(null),
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toContain('Missing "file"');
    });

    it('400s when mime type is not in the allowlist', async () => {
        const res = await app().request('/api/v1/audio/upload', {
            method: 'POST',
            headers: AUTH,
            body: makeFormData(
                new File([new Uint8Array(10)], 'evil.exe', { type: 'application/octet-stream' }),
            ),
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toContain('Unsupported audio type');
    });

    it('400s when file exceeds 25MB', async () => {
        // 26 MB of zeros — over the 25 MB cap.
        const big = new Uint8Array(26 * 1024 * 1024);

        const res = await app().request('/api/v1/audio/upload', {
            method: 'POST',
            headers: AUTH,
            body: makeFormData(new File([big], 'big.m4a', { type: 'audio/m4a' })),
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toContain('too large');
    });

    it('stores at the CID-derived tenancy path and returns the canonical blob ref', async () => {
        vi.mocked(uploadFile).mockResolvedValue('https://cdn/example');

        const bytes = new Uint8Array(100);
        const res = await app().request('/api/v1/audio/upload', {
            method: 'POST',
            headers: AUTH,
            body: makeFormData(new File([bytes], 'clip.m4a', { type: 'audio/m4a' })),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        const blob = body.data.blob;
        // Canonical AT Protocol blob-ref shape with a real CIDv1 (raw+sha256
        // CIDs base32-encode with the 'bafkrei' prefix).
        expect(blob.$type).toBe('blob');
        expect(blob.ref.$link).toMatch(/^bafkrei[a-z2-7]+$/);
        expect(blob.mimeType).toBe('audio/m4a');
        expect(blob.size).toBe(100);

        expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(1);
        const [bufferArg, pathArg, mimeArg] = vi.mocked(uploadFile).mock.calls[0];
        expect(Buffer.isBuffer(bufferArg)).toBe(true);
        // Path is derived from tenancy + CID, never stored on the record.
        expect(pathArg).toBe(`blobs/antiphony/${blob.ref.$link}`);
        expect(mimeArg).toBe('audio/m4a');
    });

    it('returns the same CID for identical bytes (content addressing)', async () => {
        vi.mocked(uploadFile).mockResolvedValue('https://cdn/example');

        async function upload(): Promise<string> {
            const res = await app().request('/api/v1/audio/upload', {
                method: 'POST',
                headers: AUTH,
                body: makeFormData(new File([new Uint8Array([1, 2, 3])], 'a.m4a', { type: 'audio/m4a' })),
            });
            const body = await res.json();
            return body.data.blob.ref.$link;
        }

        expect(await upload()).toBe(await upload());
    });
});
