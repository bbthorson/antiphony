import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * End-to-end integration test for B5 audio processing: drives the REAL
 * create → dispatch (inline stub) → hydrate pipeline through the actual
 * services and Firebase adapters, backed by an in-memory Firestore + Storage.
 * No service-layer mock — this proves the wiring the unit tests can't:
 *   - create stamps the initial processing state on the record,
 *   - inline dispatch runs the stub providers,
 *   - the transcript enrichment is written under the post's StrongRef,
 *   - hydration surfaces per-stage status and swaps playback to the denoised
 *     variant.
 */

// --- In-memory Firestore ---------------------------------------------------
const docs = new Map<string, Record<string, unknown>>();
let autoId = 0;

function setNested(target: Record<string, unknown>, path: string, value: unknown) {
    const parts = path.split('.');
    let obj = target;
    for (let i = 0; i < parts.length - 1; i++) {
        obj[parts[i]] = { ...((obj[parts[i]] as Record<string, unknown>) ?? {}) };
        obj = obj[parts[i]] as Record<string, unknown>;
    }
    obj[parts[parts.length - 1]] = value;
}

function getNested(data: Record<string, unknown> | undefined, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, p) => (acc as Record<string, unknown>)?.[p], data);
}

function makeDocRef(name: string, id: string) {
    const key = `${name}/${id}`;
    return {
        id,
        get: async () => ({ exists: docs.has(key), id, data: () => docs.get(key) }),
        set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
            const existing = opts?.merge ? docs.get(key) ?? {} : {};
            docs.set(key, { ...existing, ...data });
        },
        update: async (data: Record<string, unknown>) => {
            const cur = { ...(docs.get(key) ?? {}) };
            for (const [k, v] of Object.entries(data)) {
                if (k.includes('.')) setNested(cur, k, v);
                else cur[k] = v;
            }
            docs.set(key, cur);
        },
        collection: (sub: string) => makeCollection(`${name}/${id}/${sub}`),
    };
}

function makeCollection(name: string) {
    return {
        doc: (id?: string) => makeDocRef(name, id ?? `auto-${++autoId}`),
        where: (field: string, op: string, value: unknown) => ({
            limit: () => ({ get: async () => queryDocs(name, field, op, value) }),
            get: async () => queryDocs(name, field, op, value),
        }),
    };
}

function queryDocs(name: string, field: string, op: string, value: unknown) {
    const out: Array<{ id: string; data: () => unknown }> = [];
    for (const [key, data] of docs.entries()) {
        if (!key.startsWith(`${name}/`) || key.slice(name.length + 1).includes('/')) continue;
        const val = getNested(data, field);
        const match = op === 'in' ? Array.isArray(value) && value.includes(val) : val === value;
        if (match) out.push({ id: key.slice(name.length + 1), data: () => data });
    }
    return { docs: out, empty: out.length === 0 };
}

const db = {
    collection: (name: string) => makeCollection(name),
    getAll: async (...refs: Array<{ get: () => Promise<unknown> }>) =>
        Promise.all(refs.map((r) => r.get())),
    runTransaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({ get: async () => ({ exists: false, data: () => undefined }), set: () => undefined, update: () => undefined }),
};

// --- In-memory Storage -----------------------------------------------------
const BLOB_BYTES = Buffer.from([1, 2, 3, 4]);

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => db,
    getAdmin: () => ({ firestore: { Timestamp: { fromMillis: (ms: number) => ({ _ms: ms }) } } }),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({
        bucket: () => ({
            name: 'test-bucket',
            file: (path: string) => ({
                download: async () => [BLOB_BYTES],
                save: async () => undefined,
                getSignedUrl: async () => [`https://signed.example/${path}`],
            }),
        }),
    }),
    isUsingEmulator: () => false,
}));

vi.mock('../../../lib/idempotency.js', () => ({
    checkIdempotency: vi.fn(async () => null),
    saveIdempotencyResult: vi.fn(async () => undefined),
    IdempotencyInProgressError: class extends Error {},
}));

vi.mock('../../../middleware/rate-limit.js', () => ({
    RATE_LIMITS: { read: {}, write: {}, expensive: {} },
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

// The caller authenticates as the application `test-app` via a service token;
// the acting end user (`u1`) is asserted with X-Antiphony-Acting-Actor.
const SERVICE_TOKEN = 'svc-tok-abcdefghijklmnopqrstuvwxyz012345';
process.env.LOG_LEVEL = 'silent';
process.env.ANTIPHONY_ORIGIN_APP_ID = 'test-app';
process.env.ANTIPHONY_APP_TOKENS = `test-app:${SERVICE_TOKEN}`;
process.env.ANTIPHONY_PROCESSING_INLINE = 'true';

const { app } = await import('../../../app.js');
const { cidForBytes } = await import('../../../lib/cid.js');

// Seed the boot-validated app-DID snapshot the way index.ts does at startup —
// app() doesn't run the boot gate, so the test populates it directly with a
// fake did:web document (no network I/O). Without this, hydration's getAppDid
// throws for the 'test-app' tenant.
const { validateAllPins } = await import('../../../lib/app-did.js');
await validateAllPins({
    raw: 'test-app:did:web:test-app.example',
    fetchImpl: (async () => ({
        ok: true,
        json: async () => ({
            id: 'did:web:test-app.example',
            service: [
                { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://api.antiphony.dev' },
            ],
        }),
    })) as unknown as typeof fetch,
});

const ORIGINAL_LINK = 'bafkreioriginalaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EMBED = {
    $type: 'dev.antiphony.embed.audio',
    audio: { $type: 'blob', ref: { $link: ORIGINAL_LINK }, mimeType: 'audio/webm', size: 2048 },
    durationMs: 4200,
};
const AUTH = {
    Authorization: `Bearer ${SERVICE_TOKEN}`,
    'x-antiphony-acting-actor': 'u1',
    'Content-Type': 'application/json',
};

async function createPost(body: Record<string, unknown>): Promise<string> {
    const res = await app().request('/api/v1/posts', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { postId: string } }).data.postId;
}

async function getPost(postId: string) {
    const res = await app().request(`/api/v1/posts/${postId}`, { headers: AUTH });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { embed?: Record<string, unknown> } }).data;
}

describe('POST /api/v1/posts — audio processing (B5)', () => {
    // Provider selection is env-driven, so env is test state. `ELEVENLABS_API_KEY`
    // must be cleared alongside the stub flag: the "no provider ⇒ skipped" test
    // below runs with the stub OFF, so a real key in the developer's shell would
    // both break the assertion AND fire a live, billed API call from the suite.
    const providerEnv = ['ANTIPHONY_PROCESSING_STUB', 'ELEVENLABS_API_KEY'] as const;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        docs.clear();
        autoId = 0;
        for (const key of providerEnv) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
    });
    afterEach(() => {
        for (const key of providerEnv) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });

    it('runs transcribe + denoise inline and surfaces them on the view', async () => {
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        const postId = await createPost({
            text: 'hello world',
            embed: EMBED,
            processing: { transcribe: true, denoise: true },
        });

        const data = await getPost(postId);
        expect(data.embed?.processing).toEqual({ transcribe: 'ready', denoise: 'ready' });
        // The stub transcript was lifted onto the embed.
        expect((data.embed?.transcript as { text?: string })?.text).toBe('[stub transcript]');
        // Playback resolves to the DENOISED variant's content-addressed blob.
        const denoisedCid = await cidForBytes(new Uint8Array(BLOB_BYTES));
        expect(data.embed?.url).toBe(`https://signed.example/blobs/test-app/${denoisedCid}`);
    });

    it('marks a requested stage skipped when the deployment has no provider', async () => {
        // STUB unset ⇒ no providers ⇒ transcribe unavailable.
        const postId = await createPost({
            text: 'hello world',
            embed: EMBED,
            processing: { transcribe: true },
        });

        const data = await getPost(postId);
        expect(data.embed?.processing).toEqual({ transcribe: 'skipped' });
        expect(data.embed?.transcript).toBeUndefined();
        // No denoise ⇒ playback stays on the original audio.
        expect(data.embed?.url).toBe(`https://signed.example/blobs/test-app/${ORIGINAL_LINK}`);
    });

    it('leaves posts without a processing opt-in completely unchanged', async () => {
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        const postId = await createPost({ text: 'hello world', embed: EMBED });

        const data = await getPost(postId);
        expect(data.embed?.processing).toBeUndefined();
        expect(data.embed?.transcript).toBeUndefined();
        expect(data.embed?.url).toBe(`https://signed.example/blobs/test-app/${ORIGINAL_LINK}`);
    });
});
