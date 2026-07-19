import { GoogleAuth } from 'google-auth-library';
import { PROCESSING_LEASE_MS } from '@antiphony/core/services/audio-processing';
import type {
    ProcessingDispatchPort,
    ProcessingJob,
} from '@antiphony/core/ports/processing-dispatch';
import type { Logger } from '@antiphony/core/ports/logger';

/**
 * Cloud Tasks dispatcher — the durable production adapter behind
 * `ProcessingDispatchPort`.
 *
 * Enqueues one HTTP task per job, targeting this deployment's own
 * `/api/v1/system/process-audio` worker route. Resolves once Cloud Tasks has
 * accepted the task (durable), not once the work has run — which is the port's
 * contract and the whole point of the seam: the create request returns as soon
 * as the job is safely recorded, and an ElevenLabs call plus two ffmpeg runs
 * happen on someone else's clock.
 *
 * ## REST, not `@google-cloud/tasks`
 *
 * The official client pulls gRPC and protobufjs, which is precisely the class
 * of dependency this bundle has already been bitten by twice — `firebase-admin`
 * is external for exactly that reason, and `ffmpeg-static` shipped an artifact
 * that could not boot. The REST surface here is one authenticated POST with a
 * JSON body; taking ~50MB of transitive native deps and a bundler exemption to
 * avoid writing it would be a bad trade.
 *
 * It is also the portable choice. `apps/core-api` may move to Cloudflare (see
 * the plan's § Deployment portability), where a gRPC client cannot run at all
 * but `fetch` against a REST endpoint can. That does not make this file
 * portable — it is a GCP adapter and a Cloudflare Queues one replaces it
 * wholesale — but it keeps the *option* from being foreclosed by a dependency.
 *
 * ## Auth
 *
 * Outbound (us → Cloud Tasks): Application Default Credentials. On App Hosting
 * that is the runtime service account, which needs `roles/cloudtasks.enqueuer`.
 *
 * Inbound (Cloud Tasks → our worker): the shared `SYSTEM_AUTH_TOKEN` bearer,
 * carried in the task's own headers, same as every other `/system/*` caller.
 *
 * **The token is stored by Cloud Tasks for the task's lifetime**, which is a
 * real if bounded exposure — anyone who can read tasks in the queue can read
 * the secret. Cloud Tasks supports `oidcToken` instead, which would have Google
 * mint a per-request identity token and store nothing; that is the better
 * mechanism and the reason this is worth writing down. It is not used here
 * because `requireSystemAuth` verifies a shared secret and nothing else, so
 * adopting OIDC means changing how every `/system/*` route authenticates, not
 * just this one. `middleware/system-auth.ts` already names itself the swap
 * point for exactly this migration.
 */

/** Cloud Tasks REST endpoint. v2 is the current GA surface. */
const TASKS_API = 'https://cloudtasks.googleapis.com/v2';

/**
 * How long Cloud Tasks lets one delivery run before aborting it.
 *
 * Derived from the lease rather than chosen, and that is the load-bearing part.
 * A delivery permitted to outlive its own lease is one whose claim can expire
 * mid-pass, letting a second runner start while the first is still writing —
 * the concurrent-write hazard the lease exists to close, reached from the one
 * direction the lease itself cannot defend against. Holding the deadline AT the
 * lease means Cloud Tasks kills the request no later than the claim lapses.
 *
 * This bounds the overlap; it does not eliminate it. Cloud Tasks aborts the
 * HTTP *request*, and a worker that ignores client disconnect can keep running
 * briefly after. The residual window is small and bounded where it used to be
 * unbounded, but a stage that must never double-write still wants its own
 * check — see the note in the plan's step 8.
 */
const DISPATCH_DEADLINE_S = Math.floor(PROCESSING_LEASE_MS / 1000);

/** Budget for the enqueue call itself. This one IS in the request path. */
const ENQUEUE_TIMEOUT_MS = 10_000;

export interface CloudTasksConfig {
    project: string;
    location: string;
    queue: string;
    /** Absolute URL of this deployment's `/api/v1/system/process-audio`. */
    workerUrl: string;
    /** Shared secret the worker route authenticates with. */
    systemAuthToken: string;
}

/**
 * Read the adapter's config from env, or explain what is missing.
 *
 * Returns the reason rather than just `undefined` so the caller can tell a
 * deployment that never opted in from one that opted in and got it wrong. Those
 * look identical at the dispatch site and are opposite problems: the first is
 * fine, the second silently drops every job.
 */
export function cloudTasksConfig():
    | { config: CloudTasksConfig; missing?: undefined }
    | { config?: undefined; missing: string[] } {
    // The project is the one value with a conventional source: App Hosting and
    // Cloud Run both set GOOGLE_CLOUD_PROJECT, so requiring it explicitly would
    // be asking for a value the platform already knows.
    const project =
        process.env.ANTIPHONY_TASKS_PROJECT?.trim() ||
        process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
        process.env.GCLOUD_PROJECT?.trim();
    const location = process.env.ANTIPHONY_TASKS_LOCATION?.trim();
    const queue = process.env.ANTIPHONY_TASKS_QUEUE?.trim();
    const workerUrl = process.env.ANTIPHONY_TASKS_WORKER_URL?.trim();
    const systemAuthToken = process.env.SYSTEM_AUTH_TOKEN?.trim();

    const missing: string[] = [];
    if (!project) missing.push('ANTIPHONY_TASKS_PROJECT (or GOOGLE_CLOUD_PROJECT)');
    if (!location) missing.push('ANTIPHONY_TASKS_LOCATION');
    if (!queue) missing.push('ANTIPHONY_TASKS_QUEUE');
    if (!workerUrl) missing.push('ANTIPHONY_TASKS_WORKER_URL');
    // Without this the enqueue succeeds and every delivery 401s — a failure
    // that surfaces only in the queue's retry counts, nowhere near the cause.
    if (!systemAuthToken) missing.push('SYSTEM_AUTH_TOKEN');

    if (missing.length > 0) return { missing };
    return {
        config: {
            project: project!,
            location: location!,
            queue: queue!,
            workerUrl: workerUrl!,
            systemAuthToken: systemAuthToken!,
        },
    };
}

/**
 * The vars that express an INTENT to use Cloud Tasks.
 *
 * Deliberately not every var `cloudTasksConfig()` reads. Two of those are set
 * for reasons that have nothing to do with queueing — `GOOGLE_CLOUD_PROJECT` by
 * the platform, `SYSTEM_AUTH_TOKEN` because every other `/system/*` route
 * already requires it — so counting them cannot distinguish "opted out" from
 * "opted in and got it wrong". These three have no default and no other
 * consumer: nothing sets them by accident.
 */
const TASKS_INTENT_ENV = [
    'ANTIPHONY_TASKS_LOCATION',
    'ANTIPHONY_TASKS_QUEUE',
    'ANTIPHONY_TASKS_WORKER_URL',
    'ANTIPHONY_TASKS_PROJECT',
] as const;

/**
 * Whether this deployment asked for durable dispatch at all.
 *
 * Lets the dispatch seam tell a deployment that never opted in (fine — noop is
 * the correct answer, silently) from one that opted in and left a var out (an
 * outage: every post sits `pending` forever). Both reach the noop dispatcher and
 * only this distinguishes them.
 */
export function cloudTasksRequested(): boolean {
    return TASKS_INTENT_ENV.some((k) => !!process.env[k]?.trim());
}

/**
 * ADC client, memoized. `GoogleAuth` caches the access token and refreshes it
 * before expiry, so this must not be rebuilt per call — a fresh instance would
 * re-fetch a token on every dispatch and put a metadata-server round-trip in
 * the create path.
 */
let authClient: GoogleAuth | undefined;
function auth(): GoogleAuth {
    authClient ??= new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    return authClient;
}

export function cloudTasksDispatcher(
    config: CloudTasksConfig,
    logger: Logger,
    // Injected so the adapter's own tests can assert the request it builds
    // without standing up a Cloud Tasks emulator. Production passes nothing.
    fetchImpl: typeof fetch = fetch,
): ProcessingDispatchPort {
    const parent = `projects/${config.project}/locations/${config.location}/queues/${config.queue}`;

    return {
        async dispatch(job: ProcessingJob): Promise<void> {
            const token = await auth().getAccessToken();
            if (!token) throw new Error('Cloud Tasks: no access token from ADC');

            // No task NAME, so no name-based dedup. Cloud Tasks would dedup on
            // it for ~1 hour after completion, which sounds like exactly what
            // an at-least-once queue wants — and is wrong here. Recompute
            // re-dispatches the SAME post when a later PATCH changes its
            // stages, and under name dedup that second, legitimate job would be
            // silently discarded as a duplicate. Concurrency is the lease's
            // job; it handles redelivery correctly and does not confuse it with
            // a real re-request.
            const body = JSON.stringify({
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: config.workerUrl,
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${config.systemAuthToken}`,
                        },
                        // The API takes the payload base64-encoded.
                        body: Buffer.from(
                            JSON.stringify({
                                originAppId: job.originAppId,
                                postId: job.postId,
                            }),
                        ).toString('base64'),
                    },
                    dispatchDeadline: `${DISPATCH_DEADLINE_S}s`,
                },
            });

            // Bound the enqueue: this one runs inside the create request, so a
            // hung connection to Cloud Tasks would hold the caller's response
            // open. `dispatchProcessing` catches, but only once we return.
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), ENQUEUE_TIMEOUT_MS);
            try {
                const res = await fetchImpl(`${TASKS_API}/${parent}/tasks`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                    body,
                    signal: controller.signal,
                });
                if (!res.ok) {
                    const detail = await res.text().catch(() => '');
                    throw new Error(
                        `Cloud Tasks enqueue failed (${res.status}): ${detail.slice(0, 500)}`,
                    );
                }
                logger.info(
                    { postId: job.postId, originAppId: job.originAppId, queue: config.queue },
                    '[audio-processing] job enqueued',
                );
            } finally {
                clearTimeout(timer);
            }
        },
    };
}
