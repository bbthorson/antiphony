import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../outbound/postgres/testing/pglite.js';
import { createFakeBucket } from '../../outbound/r2/testing/fake-bucket.js';

/**
 * End-to-end integration test for B5 audio processing: drives the REAL
 * create → dispatch (inline stub) → hydrate pipeline through the actual
 * services and the Postgres + R2 bindings. No service-layer mock — this proves
 * the wiring the unit tests cannot:
 *   - create stamps the initial processing state on the record,
 *   - inline dispatch runs the stub providers,
 *   - the transcript enrichment is written under the post's StrongRef,
 *   - hydration surfaces per-stage status and swaps playback to the denoised
 *     variant.
 *
 * ## It used to run against a hand-written in-memory Firestore
 *
 * ~130 lines of it: a `Map` of documents, dotted-path `set` semantics, and a
 * `FieldValue.delete()` sentinel check that imported the real `firebase-admin`
 * purely to recognise the sentinel. That fake WAS the risk — it encoded one
 * reading of Firestore's update semantics, and the pipeline was only ever as
 * correct as that reading.
 *
 * It now runs on PGlite (real PostgreSQL 18, in-process) applying the shipped
 * `db/schema.sql`, and the in-memory `R2BucketLike` the R2 binding suites
 * already use. Nothing here is a stand-in for the store any more: the SQL runs
 * against a real planner, and the only fakes left are the two things this test
 * is not about — the processing providers (stubs, by env flag, exactly as in
 * production dev) and the app-DID document.
 */

/** The database and bucket for the current test; bound into the request env. */
let db: TestDatabase;
let bucket: ReturnType<typeof createFakeBucket>;

/**
 * The composition root builds its SQL client from `DATABASE_URL` via
 * `neonSqlClient`. Point that at PGlite instead: everything above it — the
 * Postgres bindings, the service graph, the routes — stays real, which is the
 * whole point of composing through the root rather than mocking it.
 */
vi.mock('../../outbound/postgres/client.js', () => ({
    neonSqlClient: () => db,
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
// Post views carry a playback URL pointing at this deployment's own audio proxy
// (the proxy streams bytes now instead of redirecting to a signed storage URL),
// so hydrating an embed needs a public base URL. Without it `audioPlaybackUrl`
// returns null and the whole embed is omitted.
process.env.ANTIPHONY_PUBLIC_BASE_URL = 'https://api.test';

const BUCKET_NAME = 'antiphony-r2-bucket';

/** The bindings a Worker would receive, assembled per request. */
const bindings = () => ({
    DATABASE_URL: 'postgresql://pglite/antiphony',
    BLOBS: bucket,
    ANTIPHONY_R2_BUCKET: BUCKET_NAME,
});

/** The proxy URL a hydrated embed should carry for a blob under this tenant. */
const proxyUrl = (cid: string) =>
    `https://api.test/api/v1/audio?url=${encodeURIComponent(`blobs/test-app/${cid}`)}`;

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

/** The original audio, seeded into the bucket and read by the denoise stage. */
const BLOB_BYTES = new Uint8Array([1, 2, 3, 4]);

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

// The bindings go in as the request env, the way a Worker delivers them —
// `app()` is the same factory production uses and holds no store of its own.
async function createPost(body: Record<string, unknown>): Promise<string> {
    const res = await app().request(
        '/api/v1/posts',
        { method: 'POST', headers: AUTH, body: JSON.stringify(body) },
        bindings(),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { postId: string } }).data.postId;
}

async function getPost(postId: string) {
    const res = await app().request(
        `/api/v1/posts/${postId}`,
        { headers: AUTH },
        bindings(),
    );
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

    beforeAll(async () => {
        db = await createTestDatabase();
    });
    afterAll(async () => {
        await db.close();
    });

    beforeEach(async () => {
        await db.truncate();
        // A fresh bucket per test, seeded with the original audio at the
        // tenancy-scoped path the embed's blob ref resolves to
        // (`blobs/{originAppId}/{cid}` — lib/blob-path.ts). The denoise stage
        // reads these bytes and writes its variant back alongside them.
        bucket = createFakeBucket();
        await bucket.put(`blobs/test-app/${ORIGINAL_LINK}`, BLOB_BYTES, {
            httpMetadata: { contentType: 'audio/webm' },
        });
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
        const denoisedCid = await cidForBytes(BLOB_BYTES);
        expect(data.embed?.url).toBe(proxyUrl(denoisedCid));
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
        expect(data.embed?.url).toBe(proxyUrl(ORIGINAL_LINK));
    });

    it('leaves posts without a processing opt-in completely unchanged', async () => {
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        const postId = await createPost({ text: 'hello world', embed: EMBED });

        const data = await getPost(postId);
        expect(data.embed?.processing).toBeUndefined();
        expect(data.embed?.transcript).toBeUndefined();
        expect(data.embed?.url).toBe(proxyUrl(ORIGINAL_LINK));
    });
});
