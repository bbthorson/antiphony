import type { Logger } from '@antiphony/core/ports/logger';
import type {
    RenditionRequest,
    RenditionServicePort,
} from '../../../ports/rendition-service.js';

/**
 * HTTP binding for `RenditionServicePort` — one authenticated POST at
 * `apps/audio-rendition`.
 *
 * Portable by construction: a `fetch` with a JSON body and a bearer, which is
 * the same reason the Cloud Tasks adapter was written against the REST surface
 * rather than the gRPC client. Nothing here is Workers-specific.
 *
 * ## The budget is the load-bearing part
 *
 * The consumer this exists for is a Twilio `<Play>` fetch on a live call. A
 * caller waiting on a cold transcode is hearing silence, and
 * `specs/mp3-rendition-stage.md` is emphatic that deleting that failure is the
 * whole point of the work — so an unbounded wait here would reintroduce it
 * while looking like a feature.
 *
 * So: wait briefly, and on expiry give up on THIS request. The transcode is not
 * cancelled by us giving up — the service is already running ffmpeg and will
 * write the rendition when it finishes — so the next request for the same
 * `(cid, format)` is a cache hit. That is the "degrade once, warm the cache"
 * shape Vox Pop's IVR already uses for the same reason, and it is why the caller
 * treats `false` as "not available yet" rather than "never".
 */

/**
 * How long to wait for a transcode before answering without one.
 *
 * Chosen against the consumer, not the work: a voicemail-length clip transcodes
 * in about a second, so anything that has not finished in eight is either a cold
 * container start or something wrong — and in both cases the caller is better
 * served by a prompt "no" it can degrade from than by a connection held open.
 */
const RENDER_TIMEOUT_MS = 8_000;

export interface RenditionServiceConfig {
    /** Base URL of the deployed service, no trailing slash. */
    baseUrl: string;
    /** The shared secret its `/render` route authenticates with. */
    systemAuthToken: string;
}

/**
 * Read config from env, or report what is missing.
 *
 * Both values or neither. A URL with no token would produce a service call that
 * 401s on every miss — a rendition path that looks configured and never
 * succeeds, which is worse than one that is plainly off.
 */
export function renditionServiceConfig():
    | { config: RenditionServiceConfig; missing?: undefined }
    | { config?: undefined; missing: string[] } {
    const baseUrl = process.env.ANTIPHONY_RENDITION_SERVICE_URL?.trim().replace(/\/+$/, '');
    const systemAuthToken = process.env.SYSTEM_AUTH_TOKEN?.trim();

    const missing: string[] = [];
    if (!baseUrl) missing.push('ANTIPHONY_RENDITION_SERVICE_URL');
    if (!systemAuthToken) missing.push('SYSTEM_AUTH_TOKEN');

    if (missing.length > 0) return { missing };
    return { config: { baseUrl: baseUrl!, systemAuthToken: systemAuthToken! } };
}

export function httpRenditionService(
    config: RenditionServiceConfig,
    logger: Logger,
    // Injected so the adapter's tests can assert the request it builds without
    // standing up the service. Production passes nothing.
    fetchImpl: typeof fetch = fetch,
): RenditionServicePort {
    return {
        async ensure(request: RenditionRequest): Promise<boolean> {
            try {
                const res = await fetchImpl(`${config.baseUrl}/render`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${config.systemAuthToken}`,
                    },
                    body: JSON.stringify(request),
                    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
                });

                if (res.ok) return true;

                // 404 means the SOURCE does not exist — the caller asked for a
                // rendition of audio that is not there. Logged at `warn`
                // because it is a normal consequence of a bad request rather
                // than a fault, and separated from the rest because the two
                // send someone to different places.
                if (res.status === 404) {
                    logger.warn({ ...request }, '[rendition] no source blob to derive from');
                    return false;
                }

                logger.error(
                    { ...request, status: res.status },
                    '[rendition] service refused the render',
                );
                return false;
            } catch (err) {
                // A timeout lands here, and it is the expected case rather than
                // an exceptional one: the transcode is still running and will
                // land, so the NEXT request for this pair is a cache hit. Kept
                // at `warn` for that reason — paging on it would page on cold
                // starts.
                const timedOut = err instanceof Error && err.name === 'TimeoutError';
                if (timedOut) {
                    logger.warn(
                        { ...request, budgetMs: RENDER_TIMEOUT_MS },
                        '[rendition] render exceeded this request budget; it should land for the next one',
                    );
                } else {
                    logger.error({ ...request, err }, '[rendition] service unreachable');
                }
                return false;
            }
        },
    };
}
