import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@antiphony/core/ports/logger';

/**
 * Cloud Tasks dispatcher (step 8).
 *
 * Asserts the REQUEST this adapter builds — the queue path, the auth on both
 * legs, the payload shape, and the deadline coupling — because none of that is
 * observable until a real queue rejects it, and by then the failure surfaces as
 * a retry count in a GCP console rather than anything in this repo.
 */

// ADC is not available in tests and would try the metadata server. Stubbed at
// the module boundary so the adapter's own logic is what gets exercised.
const getAccessToken = vi.fn(async () => 'adc-token');
vi.mock('google-auth-library', () => ({
    GoogleAuth: class {
        getAccessToken = getAccessToken;
    },
}));

const { cloudTasksDispatcher, cloudTasksConfig, cloudTasksRequested } = await import(
    './cloud-tasks.js'
);

function loggerStub(): Logger {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

const CONFIG = {
    project: 'proj',
    location: 'us-central1',
    queue: 'processing',
    workerUrl: 'https://api.example/api/v1/system/process-audio',
    systemAuthToken: 'sys-token-abcdefghijklmnopqrstuvwxyz01',
};

function okFetch() {
    return vi.fn(async () => new Response(JSON.stringify({ name: 'tasks/1' }), { status: 200 }));
}

/** The parsed body of the single enqueue call a fetch stub received. */
function enqueuedTask(fetchImpl: ReturnType<typeof okFetch>) {
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    return JSON.parse(init.body as string).task;
}

describe('cloudTasksDispatcher', () => {
    beforeEach(() => {
        getAccessToken.mockClear();
        getAccessToken.mockResolvedValue('adc-token');
    });

    it('enqueues against the configured queue path', async () => {
        const fetchImpl = okFetch();

        await cloudTasksDispatcher(CONFIG, loggerStub(), fetchImpl).dispatch({
            originAppId: 'vox-pop',
            postId: 'p1',
        });

        const [url] = fetchImpl.mock.calls[0] as unknown as [string];
        expect(url).toBe(
            'https://cloudtasks.googleapis.com/v2/projects/proj/locations/us-central1/queues/processing/tasks',
        );
    });

    it('carries the job identifiers in a base64 payload', async () => {
        const fetchImpl = okFetch();

        await cloudTasksDispatcher(CONFIG, loggerStub(), fetchImpl).dispatch({
            originAppId: 'vox-pop',
            postId: 'p1',
        });

        const task = enqueuedTask(fetchImpl);
        expect(task.httpRequest.url).toBe(CONFIG.workerUrl);
        expect(task.httpRequest.httpMethod).toBe('POST');
        // The API takes the payload base64-encoded; a raw JSON string here
        // would be accepted by Cloud Tasks and arrive at the worker as garbage.
        const decoded = JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString());
        expect(decoded).toEqual({ originAppId: 'vox-pop', postId: 'p1' });
    });

    it('authenticates both legs: ADC outbound, system token inbound', async () => {
        const fetchImpl = okFetch();

        await cloudTasksDispatcher(CONFIG, loggerStub(), fetchImpl).dispatch({
            originAppId: 'vox-pop',
            postId: 'p1',
        });

        // Outbound, us → Cloud Tasks.
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer adc-token');
        // Inbound, Cloud Tasks → our worker. Without this the enqueue succeeds
        // and every delivery 401s, visible only in the queue's retry counts.
        expect(enqueuedTask(fetchImpl).httpRequest.headers.Authorization).toBe(
            `Bearer ${CONFIG.systemAuthToken}`,
        );
    });

    it('bounds the delivery by the processing lease, not past it', async () => {
        // The coupling that keeps a delivery from outliving its own claim. A
        // deadline LONGER than the lease lets the first runner still be writing
        // when the lease lapses and a second one starts — the concurrent-write
        // hazard the lease exists to close, reached from the one direction the
        // lease cannot defend against itself.
        const { PROCESSING_LEASE_MS } = await import('@antiphony/core/services/audio-processing');
        const fetchImpl = okFetch();

        await cloudTasksDispatcher(CONFIG, loggerStub(), fetchImpl).dispatch({
            originAppId: 'vox-pop',
            postId: 'p1',
        });

        const deadlineS = Number(enqueuedTask(fetchImpl).dispatchDeadline.replace('s', ''));
        expect(deadlineS).toBeLessThanOrEqual(PROCESSING_LEASE_MS / 1000);
    });

    it('sets no task name, so a recompute re-dispatch is not deduped away', async () => {
        // Name-based dedup looks right for an at-least-once queue and is wrong
        // here: recompute re-dispatches the SAME post when a later PATCH changes
        // its stages, and Cloud Tasks would silently discard that legitimate
        // second job for ~1 hour. Concurrency is the lease's problem.
        const fetchImpl = okFetch();

        await cloudTasksDispatcher(CONFIG, loggerStub(), fetchImpl).dispatch({
            originAppId: 'vox-pop',
            postId: 'p1',
        });

        expect(enqueuedTask(fetchImpl).name).toBeUndefined();
    });

    it('throws on a non-2xx from Cloud Tasks', async () => {
        // The port forbids swallowing: a dispatcher that absorbed its own
        // failures would be indistinguishable from one that worked. The
        // dispatch site catches, and it can only do that if this rejects.
        const fetchImpl = vi.fn(async () => new Response('PERMISSION_DENIED', { status: 403 }));

        await expect(
            cloudTasksDispatcher(CONFIG, loggerStub(), fetchImpl).dispatch({
                originAppId: 'vox-pop',
                postId: 'p1',
            }),
        ).rejects.toThrow(/403/);
    });

    it('throws when ADC yields no token rather than enqueuing unauthenticated', async () => {
        getAccessToken.mockResolvedValue(null as unknown as string);
        const fetchImpl = okFetch();

        await expect(
            cloudTasksDispatcher(CONFIG, loggerStub(), fetchImpl).dispatch({
                originAppId: 'vox-pop',
                postId: 'p1',
            }),
        ).rejects.toThrow(/access token/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('cloudTasksConfig', () => {
    const ENV_KEYS = [
        'ANTIPHONY_TASKS_PROJECT',
        'ANTIPHONY_TASKS_LOCATION',
        'ANTIPHONY_TASKS_QUEUE',
        'ANTIPHONY_TASKS_WORKER_URL',
        'SYSTEM_AUTH_TOKEN',
        'GOOGLE_CLOUD_PROJECT',
        'GCLOUD_PROJECT',
    ];
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
        // Env is test state: a real SYSTEM_AUTH_TOKEN or GOOGLE_CLOUD_PROJECT in
        // the developer's shell would change which branch these assert. Same
        // treatment the ElevenLabs suites needed for their API key.
        saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
        for (const k of ENV_KEYS) delete process.env[k];
    });

    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('reports every missing var when nothing is set', () => {
        const resolved = cloudTasksConfig();

        expect(resolved.config).toBeUndefined();
        expect(resolved.missing).toHaveLength(5);
    });

    it('resolves when all vars are set', () => {
        process.env.ANTIPHONY_TASKS_PROJECT = 'proj';
        process.env.ANTIPHONY_TASKS_LOCATION = 'us-central1';
        process.env.ANTIPHONY_TASKS_QUEUE = 'processing';
        process.env.ANTIPHONY_TASKS_WORKER_URL = 'https://api.example/w';
        process.env.SYSTEM_AUTH_TOKEN = 'sys-token-abcdefghijklmnopqrstuvwxyz01';

        expect(cloudTasksConfig().config).toEqual({
            project: 'proj',
            location: 'us-central1',
            queue: 'processing',
            workerUrl: 'https://api.example/w',
            systemAuthToken: 'sys-token-abcdefghijklmnopqrstuvwxyz01',
        });
    });

    it('falls back to the platform project var', () => {
        // App Hosting and Cloud Run both set this; requiring it explicitly would
        // ask the operator for a value the platform already knows.
        process.env.GOOGLE_CLOUD_PROJECT = 'platform-proj';
        process.env.ANTIPHONY_TASKS_LOCATION = 'us-central1';
        process.env.ANTIPHONY_TASKS_QUEUE = 'processing';
        process.env.ANTIPHONY_TASKS_WORKER_URL = 'https://api.example/w';
        process.env.SYSTEM_AUTH_TOKEN = 'sys-token-abcdefghijklmnopqrstuvwxyz01';

        expect(cloudTasksConfig().config?.project).toBe('platform-proj');
    });

    it('reads no intent from the vars the platform sets on its own', () => {
        // The case the counting guard got wrong. On App Hosting the platform
        // sets GOOGLE_CLOUD_PROJECT and every other `/system/*` route already
        // requires SYSTEM_AUTH_TOKEN, so a deployment that never opted into
        // durable dispatch still arrives with two of five values present. That
        // must read as an opt-out, not as a half-finished queue setup.
        process.env.GOOGLE_CLOUD_PROJECT = 'platform-proj';
        process.env.SYSTEM_AUTH_TOKEN = 'sys-token-abcdefghijklmnopqrstuvwxyz01';

        expect(cloudTasksRequested()).toBe(false);
        expect(cloudTasksConfig().missing).toHaveLength(3);
    });

    it('reads intent from a single queue var, so a partial setup is not silent', () => {
        process.env.GOOGLE_CLOUD_PROJECT = 'platform-proj';
        process.env.SYSTEM_AUTH_TOKEN = 'sys-token-abcdefghijklmnopqrstuvwxyz01';
        process.env.ANTIPHONY_TASKS_QUEUE = 'processing';

        expect(cloudTasksRequested()).toBe(true);
        expect(cloudTasksConfig().config).toBeUndefined();
    });

    it('reports a partial config as missing rather than resolving a broken one', () => {
        // The case that must not degrade to a silent noop: the operator believes
        // durable dispatch is on, and every post sits `pending` forever.
        process.env.ANTIPHONY_TASKS_PROJECT = 'proj';
        process.env.ANTIPHONY_TASKS_LOCATION = 'us-central1';

        const resolved = cloudTasksConfig();

        expect(resolved.config).toBeUndefined();
        expect(resolved.missing).toEqual(
            expect.arrayContaining([
                'ANTIPHONY_TASKS_QUEUE',
                'ANTIPHONY_TASKS_WORKER_URL',
                'SYSTEM_AUTH_TOKEN',
            ]),
        );
    });
});
