import { z } from 'zod';
import type { TranscriberPort, TranscriptionInput, TranscriptionResult } from '@antiphony/core/ports/transcription';
import type { TranscriptSegment } from 'shared/types/audio';
import { logger } from '../../../lib/logger.js';
import { normalizeLang } from '../elevenlabs/transcriber.js';
import { workersAi } from './binding.js';

/**
 * Whisper on Cloudflare Workers AI — a `TranscriberPort` that runs inside the
 * Worker through its own `AI` binding, so audio never leaves Cloudflare and
 * there is no vendor key to hold.
 *
 * Whisper returns sentence-ish SEGMENTS with second-based timings, which is
 * already the `TimedTranscript` shape, so unlike Scribe there is no word
 * grouping here — only a unit conversion and the same guards the Scribe
 * adapter applies (non-negative, `endMs >= startMs`, BCP-47 `lang`).
 *
 * A factory for the same reason `elevenLabsTranscriber` is one: a tenant's
 * model (`ANTIPHONY_APP_STT_MODELS`) is closed over at wiring time and never
 * crosses the port.
 */

const DEFAULT_MODEL = '@cf/openai/whisper-large-v3-turbo';

/** `<VENDOR>_<CAPABILITY>_MODEL`, per `specs/provider-selection.md`. */
const MODEL_VAR = 'WORKERS_AI_STT_MODEL';

/**
 * Only the fields we read. Everything optional and non-strict: a model that
 * drops `segments` should still yield its `text`, and one that adds fields
 * should not fail the parse.
 */
const WhisperOutputSchema = z.object({
    text: z.string().optional(),
    segments: z
        .array(
            z.object({
                start: z.number().optional(),
                end: z.number().optional(),
                text: z.string().optional(),
            }),
        )
        .optional(),
    transcription_info: z.object({ language: z.string().optional() }).optional(),
});

export function workersAiTranscriber(modelOverride?: string): TranscriberPort {
    return {
        async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
            const ai = workersAi();
            // `available()` guards this in the registry; a throw here settles
            // the stage `failed` rather than saving an empty transcript.
            if (!ai) throw new Error('Workers AI binding (AI) is not bound');

            const model = modelOverride ?? (process.env[MODEL_VAR]?.trim() || DEFAULT_MODEL);

            // Whisper takes ISO-639-1. Same trimming as the Scribe adapter: a
            // BCP-47 or POSIX hint (`en-US`, `en_US`) keeps its language only.
            const language = input.langHint?.split(/[-_]/)[0]?.trim().toLowerCase();

            const raw = await ai.run(model, {
                audio: bytesToBase64(input.bytes),
                ...(language ? { language } : {}),
                // Voice replies routinely open and close on silence, which is
                // where Whisper hallucinates; VAD trims it before decoding.
                vad_filter: true,
            });

            const parsed = WhisperOutputSchema.safeParse(raw);
            if (!parsed.success) {
                logger.error({ model, issues: parsed.error.issues }, '[workers-ai] unexpected Whisper output shape');
                throw new Error(`Workers AI ${model} returned an unexpected shape`);
            }

            const body = parsed.data;
            const segments = toSegments(body.segments ?? []);
            const text = body.text?.trim();
            const lang = normalizeLang(body.transcription_info?.language);

            return {
                transcript: {
                    segments: segments.length > 0
                        ? segments
                        : text
                            ? [{ startMs: 0, endMs: input.durationMs ?? 0, text }]
                            : [],
                    ...(text ? { text } : {}),
                },
                ...(lang ? { lang } : {}),
                model,
            };
        },
    };
}

/** Exported for tests. Whisper reports seconds; the schema is integer ms. */
export function toSegments(
    raw: ReadonlyArray<{ start?: number; end?: number; text?: string }>,
): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];
    for (const seg of raw) {
        const text = seg.text?.trim();
        if (!text) continue;
        const startMs = toMs(seg.start);
        segments.push({ startMs, endMs: Math.max(toMs(seg.end), startMs), text });
    }
    return segments;
}

function toMs(seconds: number | undefined): number {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return 0;
    return Math.round(seconds * 1000);
}

/**
 * Base64 without `Buffer` (not guaranteed on workerd) and without spreading the
 * whole array into one `String.fromCharCode` call, which overflows the stack
 * on a few hundred KB of audio.
 */
export function bytesToBase64(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}
