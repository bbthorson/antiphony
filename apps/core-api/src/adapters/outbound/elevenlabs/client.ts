/**
 * Shared plumbing for the ElevenLabs outbound adapters.
 *
 * ElevenLabs is a DEPLOYMENT choice, not a contract one (see
 * `specs/enrichment-pipeline.md` § Provider policy). Nothing here is imported
 * by `@antiphony/core` — the ports it defines (`TranscriberPort`,
 * `DenoiserPort`) name no vendor, so a self-hoster swapping in Whisper writes
 * one adapter and changes nothing else.
 */

const API_BASE = 'https://api.elevenlabs.io/v1';

/** Default budget for one provider call. Audio processing is not interactive. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Resolve the API key per call (not at module load), matching how
 * `resolveProviders()` reads its env — so tests and per-env config take effect
 * without a module reset.
 */
export function elevenLabsApiKey(): string | undefined {
    const key = process.env.ELEVENLABS_API_KEY?.trim();
    return key ? key : undefined;
}

/** Raised for a non-2xx provider response, carrying the status for logging. */
export class ElevenLabsError extends Error {
    constructor(
        readonly status: number,
        readonly endpoint: string,
        body: string,
    ) {
        // Truncate: provider error bodies can be large, and this string ends up
        // in logs. The status + endpoint are what actually identify the failure.
        super(`ElevenLabs ${endpoint} failed (${status}): ${body.slice(0, 500)}`);
        this.name = 'ElevenLabsError';
    }
}

/**
 * POST a multipart form to an ElevenLabs endpoint.
 *
 * Throws `ElevenLabsError` on a non-2xx. Callers let that propagate — the
 * `AudioProcessingService` catches per stage and settles it `failed`, so one
 * provider outage never fails a whole request or blocks a sibling stage.
 */
export async function postForm(
    endpoint: string,
    form: FormData,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
    const apiKey = elevenLabsApiKey();
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');

    // Bound the call ourselves: a hung provider connection would otherwise
    // hold a Cloud Tasks worker slot until the platform timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
            method: 'POST',
            // Content-Type is deliberately unset — fetch derives it from the
            // FormData, including the multipart boundary.
            headers: { 'xi-api-key': apiKey },
            body: form,
            signal: controller.signal,
        });
        if (!res.ok) {
            throw new ElevenLabsError(res.status, endpoint, await res.text().catch(() => ''));
        }
        // Drain the body here, while the abort signal is still live. `fetch`
        // resolves at the response headers, so returning `res` directly would
        // leave the download — up to ~250 MB of isolated audio — outside the
        // timeout this function exists to impose. Both callers buffer the whole
        // body anyway, so this moves the read rather than adding a copy.
        const buffer = await res.arrayBuffer();
        // 204/205 forbid a body; `new Response(buffer, { status })` throws on
        // them even when the buffer is empty.
        const nullBody = res.status === 204 || res.status === 205;
        return new Response(nullBody ? null : buffer, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Wrap audio bytes as a `File` for multipart upload. The filename extension is
 * cosmetic to the API but helps it disambiguate container formats, so derive
 * it from the MIME type rather than sending a bare blob.
 */
export function audioFile(bytes: Uint8Array, mimeType: string, name = 'audio'): File {
    // The copy is load-bearing, not defensive: `Uint8Array` is generic over
    // `ArrayBufferLike`, and `BlobPart` wants `ArrayBuffer` specifically, so a
    // possibly-SharedArrayBuffer-backed view does not typecheck. Re-wrapping
    // narrows it, and incidentally decouples us from the caller's buffer.
    const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
    return new File([blob], `${name}.${extensionForMime(mimeType)}`, { type: mimeType });
}

function extensionForMime(mimeType: string): string {
    const base = mimeType.split(';')[0]?.trim().toLowerCase();
    switch (base) {
        case 'audio/mpeg':
        case 'audio/mp3':
            return 'mp3';
        case 'audio/wav':
        case 'audio/x-wav':
        case 'audio/wave':
            return 'wav';
        case 'audio/mp4':
        case 'audio/m4a':
        case 'audio/x-m4a':
            return 'm4a';
        case 'audio/ogg':
            return 'ogg';
        case 'audio/flac':
            return 'flac';
        case 'audio/webm':
            return 'webm';
        default:
            return 'bin';
    }
}
