import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Workers entry point — the runtime seam, not the routes.
 *
 * Three behaviours are worth pinning here because all of them are invisible in
 * normal operation and expensive when wrong:
 *
 *   - **The interim boot gate fails closed, and RETRIES.** Cloud Run's gate is
 *     `process.exit(1)`, which a Worker has no equivalent for. What replaces it
 *     has to refuse traffic on an unproven pin — and must not memoise the
 *     refusal, or a five-second `did:web` timeout permanently breaks the
 *     isolate that saw it.
 *   - **The cron actually reaches the sweep.** `antiphony_sweep_expired()`
 *     shipped with the schema and had no caller at all; a wiring mistake here
 *     reproduces exactly that, silently.
 *   - **The queue consumer retries only what a retry could fix.** Denoise and
 *     transcribe bill on the attempt, not on the success, so acking what should
 *     retry loses work and retrying what should ack spends money. The decision
 *     itself lives in `lib/process-audio-job.ts`, shared with the HTTP re-drive
 *     route; what is asserted here is that this consumer honours it.
 */

process.env.LOG_LEVEL = 'silent';

const validateAllPins = vi.fn(async () => new Map());
const sqlQuery = vi.fn(async () => [{ swept_table: 'rate_limits', deleted: 3 }]);
const process_ = vi.fn(async () => true);
let services: Record<string, unknown> = {};

// The queue consumer's job is the ack/retry decision, not the pass itself —
// `AudioProcessingService` has its own suite in packages/core.
vi.mock('@antiphony/core/services/audio-processing', async (importOriginal) => ({
    ...((await importOriginal()) as object),
    AudioProcessingService: class {
        process = process_;
    },
}));

vi.mock('./lib/app-did.js', () => ({
    validateAllPins,
    checkTenantRegistryDrift: () => ({ tokensWithoutPin: [], pinsWithoutToken: [] }),
    // `app.ts` reaches this through the post hydration path. Fixed value: pin
    // resolution is `app-did.test.ts`'s subject, not this file's.
    getAppDid: () => 'did:web:test-app.example',
}));

vi.mock('./composition.js', () => ({
    servicesFor: () => services,
}));

/** Fresh module per case — the pin gate is isolate-scoped state by design. */
async function freshWorker() {
    vi.resetModules();
    return (await import('./worker.js')).default;
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };

beforeEach(() => {
    validateAllPins.mockClear();
    sqlQuery.mockClear();
    process_.mockClear();
    validateAllPins.mockImplementation(async () => new Map());
    process_.mockImplementation(async () => true);
    services = { backend: 'postgres', sql: { query: sqlQuery }, audioProcessingDeps: {} };
});

/** One queue message, with its settlement recorded. */
function message(body: unknown, id = 'msg-1') {
    const settled: string[] = [];
    return {
        settled,
        msg: {
            id,
            body,
            ack: () => settled.push('ack'),
            retry: () => settled.push('retry'),
        },
    };
}

function batch(messages: ReturnType<typeof message>['msg'][]) {
    const retried: string[] = [];
    return {
        retried,
        value: {
            queue: 'antiphony-processing',
            messages,
            retryAll: () => retried.push('all'),
        },
    };
}

const JOB = { originAppId: 'vox-pop', postId: 'p1' };

describe('worker fetch — the interim boot gate', () => {
    it('serves once the pins validate', async () => {
        const worker = await freshWorker();
        const res = await worker.fetch(new Request('https://api.test/health'), {}, ctx);

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, backend: 'postgres' });
    });

    it('validates once per isolate, not once per request', async () => {
        // The whole reason the gate is memoised: a did:web fetch per request
        // would put a network round trip in front of every response.
        const worker = await freshWorker();
        await worker.fetch(new Request('https://api.test/health'), {}, ctx);
        await worker.fetch(new Request('https://api.test/health'), {}, ctx);

        expect(validateAllPins).toHaveBeenCalledTimes(1);
    });

    it('refuses to serve when a pin does not validate', async () => {
        // Fail-closed, carrying the same meaning `process.exit(1)` has on Cloud
        // Run: custody of the authority we would mint `at://` uris under is
        // unproven, so we answer nothing.
        validateAllPins.mockRejectedValueOnce(new Error('pds-endpoint-host-mismatch'));
        const worker = await freshWorker();

        const res = await worker.fetch(new Request('https://api.test/health'), {}, ctx);
        expect(res.status).toBe(503);
    });

    it('retries on the next request rather than poisoning the isolate', async () => {
        // A rejected promise left in the memo slot would turn one transient
        // did:web timeout into a permanently dead isolate — the failure the
        // deploy workflow already complains about, relocated to runtime.
        validateAllPins.mockRejectedValueOnce(new Error('did-doc-fetch-failed: timeout'));
        const worker = await freshWorker();

        expect((await worker.fetch(new Request('https://api.test/health'), {}, ctx)).status).toBe(
            503,
        );
        expect((await worker.fetch(new Request('https://api.test/health'), {}, ctx)).status).toBe(
            200,
        );
        expect(validateAllPins).toHaveBeenCalledTimes(2);
    });
});

describe('worker scheduled — the TTL sweep', () => {
    const cron = { scheduledTime: 0, cron: '17 * * * *' };

    it('drives antiphony_sweep_expired()', async () => {
        const worker = await freshWorker();
        await worker.scheduled(cron, {}, ctx);

        expect(sqlQuery).toHaveBeenCalledWith('select * from antiphony_sweep_expired()');
    });

    it('does not gate the sweep on pin validation', async () => {
        // Disk reclamation and did:web custody are unrelated concerns. An
        // unreachable DID document must not stop the tables being swept.
        validateAllPins.mockRejectedValue(new Error('did-doc-fetch-failed: timeout'));
        const worker = await freshWorker();

        await worker.scheduled(cron, {}, ctx);
        expect(sqlQuery).toHaveBeenCalledOnce();
    });

    it('survives a failing sweep without throwing at the runtime', async () => {
        // The sweep is pure space reclamation — it may run late, partially, or
        // not at all. A throw here would report a Cloudflare-side error on a
        // service that is fine.
        sqlQuery.mockRejectedValueOnce(new Error('connection reset'));
        const worker = await freshWorker();

        await expect(worker.scheduled(cron, {}, ctx)).resolves.toBeUndefined();
    });

    it('no-ops when no SQL backend is bound', async () => {
        services = { backend: 'firebase' };
        const worker = await freshWorker();

        await expect(worker.scheduled(cron, {}, ctx)).resolves.toBeUndefined();
        expect(sqlQuery).not.toHaveBeenCalled();
    });
});

describe('worker queue — the audio-processing consumer', () => {
    it('acks a job that ran', async () => {
        const worker = await freshWorker();
        const m = message(JOB);
        await worker.queue(batch([m.msg]).value, {}, ctx);

        expect(process_).toHaveBeenCalledWith('vox-pop', 'p1');
        expect(m.settled).toEqual(['ack']);
    });

    it('acks a declined lease — a retry would only spin against the holder', async () => {
        // `process()` returns false when another runner holds the post, or when
        // there was nothing to do. Both are normal on an at-least-once queue,
        // and the delivery decision is the same for all of them.
        process_.mockResolvedValueOnce(false);
        const worker = await freshWorker();
        const m = message(JOB);
        await worker.queue(batch([m.msg]).value, {}, ctx);

        expect(m.settled).toEqual(['ack']);
    });

    it('acks a malformed payload rather than replaying it until the queue gives up', async () => {
        const worker = await freshWorker();
        const m = message({ originAppId: 'vox-pop' });
        await worker.queue(batch([m.msg]).value, {}, ctx);

        expect(process_).not.toHaveBeenCalled();
        expect(m.settled).toEqual(['ack']);
    });

    it('retries ONLY when the pass threw', async () => {
        // The one retryable outcome: an error escaping `process()` came from
        // outside a stage's try/catch, so it is infrastructure rather than this
        // post. Nothing was recorded and the lease was already released.
        process_.mockRejectedValueOnce(new Error('database unreachable'));
        const worker = await freshWorker();
        const m = message(JOB);
        await worker.queue(batch([m.msg]).value, {}, ctx);

        expect(m.settled).toEqual(['retry']);
    });

    it('settles each message on its own, so one bad payload does not drag the batch back', async () => {
        process_.mockResolvedValueOnce(true);
        const worker = await freshWorker();
        const good = message(JOB, 'good');
        const bad = message({ nope: true }, 'bad');
        const b = batch([good.msg, bad.msg]);

        await worker.queue(b.value, {}, ctx);

        expect(good.settled).toEqual(['ack']);
        expect(bad.settled).toEqual(['ack']);
        expect(b.retried).toEqual([]);
    });

    it('returns the whole batch when the pin gate fails', async () => {
        // This handler mints `at://` uris through `buildPostUri`, and it runs
        // outside any request, so nothing else populated the snapshot for it.
        // An unresolvable did:web is infrastructure: the work was not
        // attempted and nothing was recorded, so the batch is genuinely
        // batch-wide retryable.
        validateAllPins.mockRejectedValue(new Error('did-doc-fetch-failed: timeout'));
        const worker = await freshWorker();
        const m = message(JOB);
        const b = batch([m.msg]);

        await worker.queue(b.value, {}, ctx);

        expect(process_).not.toHaveBeenCalled();
        expect(b.retried).toEqual(['all']);
        expect(m.settled).toEqual([]);
    });
});
