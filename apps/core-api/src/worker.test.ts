import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Workers entry point — the runtime seam, not the routes.
 *
 * Three behaviours are worth pinning here because all of them are invisible in
 * normal operation and expensive when wrong:
 *
 *   - **`fetch` gates nothing.** Custody is proven per tenant in the auth
 *     middleware; re-proving the whole registry here would reinstate the boot
 *     gate's global blast radius, which is the thing the replacement fixes.
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
// `worker.ts` calls `assertRequiredConfig()` at module scope, so importing it
// without this throws — which is the point of the assertion, covered directly
// in `app-config.test.ts`. Here it is setup, not the thing under test.
process.env.ANTIPHONY_PUBLIC_BASE_URL = 'https://api.test.antiphony.dev';

const revalidateAllPins = vi.fn(async () => [] as unknown[]);
const sqlQuery = vi.fn(async (_text?: string): Promise<Record<string, unknown>[]> => [
    { swept_table: 'rate_limits', deleted: 3 },
]);
const process_ = vi.fn(async () => true);
const ensureTenantPin = vi.fn(async () => undefined);
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
    revalidateAllPins,
    // Per-tenant custody proof. Its layering and failure classification are
    // `app-did.test.ts`'s subject; the middleware ordering is
    // `middleware/auth.test.ts`'s. What matters here is that the job runner
    // calls it, and what the consumer does when it refuses.
    ensureTenantPin,
    // `app.ts` reaches this through the post hydration path.
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
    revalidateAllPins.mockClear();
    sqlQuery.mockClear();
    process_.mockClear();
    ensureTenantPin.mockClear();
    revalidateAllPins.mockImplementation(async () => []);
    ensureTenantPin.mockImplementation(async () => undefined);
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

describe('worker fetch', () => {
    it('serves the app with no boot gate in front of it', async () => {
        // There is deliberately no whole-registry validation here. Doing it on
        // the first request would preserve the boot gate's worst property —
        // `validateAllPins` throws on the FIRST failure, so one bad tenant
        // fails every other tenant's requests. Custody is proven per tenant, in
        // the auth middleware. See worker.ts § There is no boot gate here.
        const worker = await freshWorker();
        const res = await worker.fetch(new Request('https://api.test/health'), {}, ctx);

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, backend: 'postgres' });
        expect(revalidateAllPins).not.toHaveBeenCalled();
    });
});

describe('worker scheduled — the TTL sweep', () => {
    const cron = { scheduledTime: 0, cron: '17 * * * *' };

    it('drives antiphony_sweep_expired()', async () => {
        const worker = await freshWorker();
        await worker.scheduled(cron, {}, ctx);

        expect(sqlQuery).toHaveBeenCalledWith('select * from antiphony_sweep_expired()');
    });

    it('revalidates every pin for drift on the same trigger', async () => {
        // Mechanism 4 of the boot-gate replacement, and the only one that
        // delivers ONGOING custody — today's design checks that solely when a
        // process happens to restart. It matters most on a low-traffic service,
        // where lazy validation might not re-check a quiet tenant for days.
        const worker = await freshWorker();
        await worker.scheduled(cron, {}, ctx);

        expect(revalidateAllPins).toHaveBeenCalledOnce();
    });

    it('sweeps even when a pin has drifted', async () => {
        // Disk reclamation and did:web custody are unrelated concerns, and the
        // drift report is a log line rather than a throw — a tenant that has
        // genuinely drifted fails closed at its next request, not here.
        revalidateAllPins.mockResolvedValueOnce([
            { originAppId: 'vox-pop', did: 'did:web:x', reason: 'did-doc-id-mismatch', kind: 'disproof' },
        ]);
        const worker = await freshWorker();

        await worker.scheduled(cron, {}, ctx);
        // The sweep specifically, not a query count: this handler also runs the
        // data-presence probe, so counting queries would make this test fail
        // whenever an unrelated diagnostic is added to the same trigger.
        expect(sqlQuery).toHaveBeenCalledWith('select * from antiphony_sweep_expired()');
    });

    it('survives a failing sweep without throwing at the runtime', async () => {
        // The sweep is pure space reclamation — it may run late, partially, or
        // not at all. A throw here would report a Cloudflare-side error on a
        // service that is fine.
        // Rejects the SWEEP specifically. `mockRejectedValueOnce` would now hit
        // the data-presence probe instead, since that runs first — the test
        // would still pass while testing something else entirely.
        sqlQuery.mockImplementation(async (text?: string) => {
            if (text?.includes('antiphony_sweep_expired')) throw new Error('connection reset');
            return [{ present: true }];
        });
        const worker = await freshWorker();

        await expect(worker.scheduled(cron, {}, ctx)).resolves.toBeUndefined();
    });

    it('probes data presence on the same trigger', async () => {
        // The incident this exists for: for ~20 minutes every surface read green
        // over an empty Neon and an empty R2, and nothing was watching. `/health`
        // can only report it when someone looks; this is the piece that looks.
        const worker = await freshWorker();
        await worker.scheduled(cron, {}, ctx);

        expect(sqlQuery).toHaveBeenCalledWith(
            'select exists(select 1 from posts limit 1) as present',
        );
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

    it('proves custody for the JOB\'s tenant before running it', async () => {
        // A pass mints `at://` uris through `buildPostUri`, and this runs
        // outside any request, so no auth middleware populated the snapshot.
        // Per tenant, not whole-registry: proving everything here would fail
        // this post over some other tenant's DID.
        const worker = await freshWorker();
        await worker.queue(batch([message(JOB).msg]).value, {}, ctx);

        expect(ensureTenantPin).toHaveBeenCalledWith('vox-pop', expect.anything());
    });

    it('retries a job whose tenant custody cannot be proven', async () => {
        // Retryable even for a positive disproof a retry cannot fix: three
        // attempts then the dead letter queue puts the job somewhere visible,
        // where acking would silently drop a post's processing over a config
        // error. Losing work is the worse failure.
        ensureTenantPin.mockRejectedValueOnce(new Error('did-doc-fetch-failed: timeout'));
        const worker = await freshWorker();
        const m = message(JOB);

        await worker.queue(batch([m.msg]).value, {}, ctx);

        expect(process_).not.toHaveBeenCalled();
        expect(m.settled).toEqual(['retry']);
    });
});
