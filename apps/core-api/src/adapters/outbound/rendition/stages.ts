import type { TrimmerPort } from '@antiphony/core/ports/audio-trimmer';
import type { WaveformPort } from '@antiphony/core/ports/audio-waveform';
import type { Logger } from '@antiphony/core/ports/logger';
import type { RenditionServiceConfig } from './http.js';

/**
 * `TrimmerPort` and `WaveformPort` over HTTP — the ingest stages, restored on
 * Workers.
 *
 * ## What this replaces, and why it had to
 *
 * Both stages used to `execFile` ffmpeg in-process
 * (`adapters/outbound/ffmpeg/{trimmer,waveform}.ts`). A Worker cannot spawn a
 * subprocess, so on Workers both resolved **unavailable** and every opted-in
 * post settled them `skipped` — the honest state, and a capability the Cloud Run
 * deployment had that its replacement did not. These adapters close that gap:
 * the compute moved to `apps/audio-rendition`, and what is left here is a
 * `fetch`.
 *
 * **The ports are unchanged.** That is the whole point of the exercise, and it
 * is what specs/cloudflare-migration.md § The ffmpeg problem predicted:
 * "`TrimmerPort` and `WaveformPort` are unchanged — the adapters become a
 * `fetch` at the rendition service instead of an `execFile`."
 * `AudioProcessingService`, `capabilitiesOf`, the stage-settling machinery, and
 * every core test never learn that the compute crossed a network.
 *
 * ## The bytes go over the wire, and that is a known cost
 *
 * The ports are `bytes in, result out`, and `AudioProcessingService` owns the
 * storage either side — it calls `readBlobBytes`, hands the bytes to the port,
 * and passes the result to `writeDerivedBlob`, which content-addresses it. That
 * ordering is what makes the derived CID Antiphony's to compute, and it has to
 * be: the derived CID goes into a record as a `BlobRef`.
 *
 * So a blob transits the Worker to reach the service. The upload route caps at
 * 25MB against a 128MB isolate, so it survives — the same spec calls streaming
 * the port the right long-term shape and explicitly not a blocker today. The
 * waveform half is already cheap: only the request carries audio.
 *
 * ## A longer budget than the rendition path, deliberately
 *
 * `httpRenditionService` waits 8s, because a caller is listening to silence
 * while it does. Nothing is listening here — these run in the queue consumer,
 * off any request — so the budget is sized against the work instead, and the
 * work is bounded by the consumer's own 15-minute ceiling either way. A stage
 * that failed at 8s on a long recording would settle `failed` for a post that
 * was going to succeed.
 */

/**
 * How long to wait for a stage.
 *
 * Two minutes, matching what the in-process runner allowed per ffmpeg pass — the
 * same work, so the same budget. Comfortably inside both the Cloud Run request
 * timeout and the queue consumer's ceiling, so this is the bound that fires
 * first and the failure says which stage rather than which platform.
 */
const STAGE_TIMEOUT_MS = 120_000;

async function callStage(
    config: RenditionServiceConfig,
    path: '/trim' | '/waveform',
    bytes: Uint8Array,
    mimeType: string,
): Promise<Response> {
    const res = await fetch(`${config.baseUrl}${path}`, {
        method: 'POST',
        headers: {
            // The mime type IS a content type. No multipart envelope and no
            // base64 — the latter would inflate a 25MB upload by a third to
            // carry one string.
            'content-type': mimeType,
            authorization: `Bearer ${config.systemAuthToken}`,
        },
        body: bytes as unknown as BodyInit,
        signal: AbortSignal.timeout(STAGE_TIMEOUT_MS),
    });
    if (!res.ok) {
        // Thrown, not returned. Unlike the rendition path — where a failure is
        // "serve without one" — a failed stage is a real outcome the service
        // layer records: `AudioProcessingService` catches per stage and settles
        // it `failed`, which is what keeps one bad stage from failing the pass.
        // Swallowing here would settle it `ready` over nothing.
        throw new Error(`${path} failed (${res.status})`);
    }
    return res;
}

export function httpTrimmer(config: RenditionServiceConfig, logger: Logger): TrimmerPort {
    return {
        async trim(input) {
            const res = await callStage(config, '/trim', input.bytes, input.mimeType);
            const bytes = new Uint8Array(await res.arrayBuffer());

            if (bytes.length === 0) {
                // A zero-length variant would be content-addressed and stored
                // as a valid-looking empty blob, replacing playable audio with
                // nothing. The service guards this too; so does this side,
                // because the consequence is a silently broken post.
                throw new Error('trim returned an empty variant');
            }

            // The duration is part of the RESULT, not a diagnostic: it becomes
            // `processedDurationMs`, which the read view serves as the post's
            // duration. Absent or unparseable is a contract violation rather
            // than something to paper over with a guess — a wrong duration is
            // served to clients as fact.
            const durationMs = Number(res.headers.get('x-duration-ms'));
            if (!Number.isFinite(durationMs) || durationMs <= 0) {
                throw new Error('trim returned no usable duration');
            }

            const mimeType = res.headers.get('content-type');
            if (!mimeType) {
                // Storing bytes under a label that does not describe them fails
                // silently: blobs are served to browsers with their stored
                // content type, so playback breaks with no exception and nothing
                // in the logs. The port's own doc calls this out.
                throw new Error('trim returned no content type');
            }

            logger.info(
                { inputBytes: input.bytes.length, outputBytes: bytes.length, durationMs },
                '[stages] trimmed',
            );
            return { bytes, mimeType, durationMs };
        },
    };
}

export function httpWaveform(config: RenditionServiceConfig, logger: Logger): WaveformPort {
    return {
        async waveform(input) {
            const res = await callStage(config, '/waveform', input.bytes, input.mimeType);
            const body = (await res.json()) as { peaks?: unknown };

            if (!Array.isArray(body.peaks) || body.peaks.length === 0) {
                // An empty peaks array would settle the stage `ready` over a
                // waveform that renders as nothing, leaving whatever the client
                // supplied in place while claiming to have replaced it.
                throw new Error('waveform returned no peaks');
            }

            const peaks = body.peaks.filter((p): p is number => typeof p === 'number');
            if (peaks.length !== body.peaks.length) {
                throw new Error('waveform returned non-numeric peaks');
            }

            logger.info({ inputBytes: input.bytes.length, peaks: peaks.length }, '[stages] waveform computed');
            return { peaks };
        },
    };
}
