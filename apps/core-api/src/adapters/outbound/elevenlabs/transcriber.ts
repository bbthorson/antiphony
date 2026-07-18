import type { TranscriberPort, TranscriptionInput, TranscriptionResult } from '@antiphony/core/ports/transcription';
import type { TranscriptSegment } from 'shared/types/audio';
import { audioFile, postForm } from './client.js';

/**
 * ElevenLabs Scribe transcriber — the reference deployment's `TranscriberPort`.
 *
 * Scribe returns WORD-level timings; `TimedTranscript` wants segments. One
 * segment per word is schema-valid but useless to a caption renderer, so this
 * adapter groups words into sentences (see `groupIntoSegments`). That grouping
 * is adapter policy, deliberately: the port describes what a transcript IS,
 * not how a given provider slices it.
 */

const DEFAULT_MODEL = 'scribe_v2';

/** Scribe's per-word entry. `start`/`end` are SECONDS, not milliseconds. */
interface ScribeWord {
    text?: string;
    start?: number;
    end?: number;
    /** `word` | `spacing` | `audio_event` — spacing carries no content. */
    type?: string;
}

interface ScribeResponse {
    language_code?: string;
    text?: string;
    words?: ScribeWord[];
}

/**
 * Ends a sentence. Includes CJK full-stop/question/exclamation forms — an
 * ASCII-only check would emit one segment for an entire Japanese transcript.
 */
const SENTENCE_END = /[.!?。！？]["')\]]?$/;

/**
 * Cap on how long one segment may run before it is cut regardless of
 * punctuation. Speech without sentence-final punctuation (dictation, a long
 * unbroken clause, a provider that omits it) would otherwise produce a single
 * segment spanning the whole clip, which defeats the point of timings.
 */
const MAX_SEGMENT_MS = 12_000;

export const elevenLabsTranscriber: TranscriberPort = {
    async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
        const model = process.env.ELEVENLABS_STT_MODEL?.trim() || DEFAULT_MODEL;

        const form = new FormData();
        form.append('file', audioFile(input.bytes, input.mimeType));
        form.append('model_id', model);
        form.append('timestamps_granularity', 'word');
        // Audio-event tags like "(laughter)" are transcription noise for a
        // caption track; the post's own text is the place for that colour.
        form.append('tag_audio_events', 'false');
        // Scribe takes ISO-639-1/3; a BCP-47 hint like `en-US` needs its region
        // subtag dropped or the request is rejected outright. Trim and re-check
        // after splitting: a whitespace-only hint is truthy but yields a blank
        // `language_code`, which fails the whole request with a 400 — losing a
        // transcript over a bad hint that is safe to simply omit.
        // Split on `_` too: `langs` is a bare `z.string()`, so a POSIX-style
        // `en_US` validates and reaches an immutable record. Splitting on `-`
        // alone would forward it whole and lose the transcript to a 400.
        const langCode = input.langHint?.split(/[-_]/)[0]?.trim().toLowerCase();
        if (langCode) {
            form.append('language_code', langCode);
        }

        const res = await postForm('/speech-to-text', form);
        const body = (await res.json()) as ScribeResponse;

        const segments = groupIntoSegments(body.words ?? []);
        const text = body.text?.trim();
        const lang = normalizeLang(body.language_code);

        return {
            transcript: {
                segments: segments.length > 0
                    ? segments
                    // Timings unavailable (or every word filtered out) but text
                    // came back: the port explicitly allows one whole-clip
                    // segment, which beats discarding a valid transcript.
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

/**
 * Group Scribe's word list into sentence-shaped segments.
 *
 * Exported for tests — this is the part of the adapter with real logic, and it
 * is pure, so it is testable without touching the network.
 */
export function groupIntoSegments(words: ScribeWord[]): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];
    let current: { startMs: number; endMs: number; parts: string[] } | null = null;

    const flush = () => {
        if (!current) return;
        const text = current.parts.join('').trim();
        // Guard the schema's `endMs >= startMs` refinement: a provider that
        // reports a zero-length or inverted span would otherwise produce a
        // record that fails validation at save time.
        if (text) {
            segments.push({
                startMs: current.startMs,
                endMs: Math.max(current.endMs, current.startMs),
                text,
            });
        }
        current = null;
    };

    for (const word of words) {
        // `spacing` entries carry the whitespace BETWEEN words — they are joined
        // into the text below, but must never start a segment or the segment
        // would begin on a gap.
        const raw = word.text ?? '';
        if (!raw) continue;
        const isSpacing = word.type === 'spacing';

        if (!current) {
            if (isSpacing) continue;
            current = { startMs: toMs(word.start), endMs: toMs(word.end), parts: [raw] };
        } else {
            current.parts.push(raw);
            current.endMs = Math.max(current.endMs, toMs(word.end));
        }

        if (isSpacing) continue;
        const overlong = current.endMs - current.startMs >= MAX_SEGMENT_MS;
        if (SENTENCE_END.test(raw.trim()) || overlong) flush();
    }
    flush();

    return segments;
}

/**
 * Normalize a provider language code to BCP-47, which is what the
 * `dev.antiphony.audio.transcript` lexicon specifies for `lang`.
 *
 * Scribe reports ISO-639-3 (`eng`, `fra`); BCP-47 requires the SHORTEST
 * available code, so English must be `en`. The Zod type is a bare
 * `z.string()`, so a raw `eng` would validate and get written into a published,
 * immutable record — a silent contract violation that is expensive to correct
 * afterwards, hence normalizing at the adapter boundary.
 *
 * `Intl.getCanonicalLocales` does the mapping natively AND correctly leaves
 * three-letter codes alone when no two-letter form exists (`yue`, `haw` are
 * already canonical), so there is no table to maintain.
 *
 * Exported for tests.
 */
export function normalizeLang(code: string | undefined): string | undefined {
    const raw = code?.trim();
    if (!raw) return undefined;
    try {
        return Intl.getCanonicalLocales(raw)[0] ?? raw;
    } catch {
        // Not a structurally valid tag — pass it through rather than dropping
        // provenance. Better a slightly-off tag than a lost one.
        return raw;
    }
}

/** Scribe reports seconds; the transcript schema is integer milliseconds. */
function toMs(seconds: number | undefined): number {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return 0;
    return Math.round(seconds * 1000);
}
