import type { TranscriberPort } from '@antiphony/core/ports/transcription';
import type { DenoiserPort } from '@antiphony/core/ports/audio-denoiser';
import type { TrimmerPort } from '@antiphony/core/ports/audio-trimmer';
import type { WaveformPort } from '@antiphony/core/ports/audio-waveform';
import {
    stubTranscriber,
    stubDenoiser,
    stubTrimmer,
    stubWaveform,
} from '../adapters/outbound/firebase/processing-providers.js';
import { elevenLabsApiKey } from '../adapters/outbound/elevenlabs/client.js';
import { elevenLabsTranscriber } from '../adapters/outbound/elevenlabs/transcriber.js';
import { elevenLabsDenoiser } from '../adapters/outbound/elevenlabs/denoiser.js';
import { ffmpegTrimmer } from '../adapters/outbound/ffmpeg/trimmer.js';
import { ffmpegWaveform } from '../adapters/outbound/ffmpeg/waveform.js';
import { ffmpegAvailable } from '../adapters/outbound/ffmpeg/run.js';
import { logger } from './logger.js';

/**
 * Per-stage provider registry — which concrete adapter each stage runs.
 *
 * This is the widened form of what `resolveProviders()` used to express with
 * one `if (elevenLabsApiKey())` branch covering two stages at once. Stages now
 * select independently, so a deployment can pair a real transcriber with a
 * different denoiser (or with a stub, while evaluating one of them) without a
 * new branch and a new flag to keep in sync with the key check.
 *
 * Selection stays DEPLOYMENT-shaped: resolved off env, never off request or
 * tenant. See `specs/provider-selection.md` § 5 for why request-scoped
 * selection is deliberately out of scope.
 *
 * Nothing here leaks upward. `@antiphony/core` still sees only the four ports,
 * and vendor concepts — model names, endpoints, error codes — stay inside the
 * adapters, per `specs/enrichment-pipeline.md` § Provider policy.
 */

interface ProviderEntry<T> {
    /** The value this entry answers to in its stage's env var. */
    readonly name: string;
    /** Whether this deployment can actually run it right now. */
    available(): boolean;
    /**
     * Never chosen by the default scan — reachable only by an exact env match.
     *
     * Stubs carry this. Without it, a production deployment that lost its API
     * key would slide from `transcribe: 'skipped'` — the truthful state, which
     * the pipeline already handles — to stub transcripts saved as real records
     * against real posts. Honest absence beats plausible garbage, and
     * `ANTIPHONY_PROCESSING_STUB` remains the way to ask for stubs wholesale.
     */
    readonly explicitOnly?: true;
    readonly port: T;
}

/**
 * Order matters: the default scan takes the first AVAILABLE non-explicitOnly
 * entry, so these lists are preference order for a deployment that names no
 * provider.
 */

const TRANSCRIBERS: ProviderEntry<TranscriberPort>[] = [
    { name: 'elevenlabs', available: () => !!elevenLabsApiKey(), port: elevenLabsTranscriber },
    { name: 'stub', available: () => true, explicitOnly: true, port: stubTranscriber },
];

const DENOISERS: ProviderEntry<DenoiserPort>[] = [
    { name: 'elevenlabs', available: () => !!elevenLabsApiKey(), port: elevenLabsDenoiser },
    { name: 'stub', available: () => true, explicitOnly: true, port: stubDenoiser },
];

// Trim and waveform are LOCAL compute — no API key, so they are available on
// their binary alone, and one probe governs both. That coupling is real (one
// ffmpeg, two stages) and is preserved by SHARING the probe function rather
// than by sharing a branch, which is what lets the two still be selected
// independently.
const TRIMMERS: ProviderEntry<TrimmerPort>[] = [
    { name: 'ffmpeg', available: ffmpegAvailable, port: ffmpegTrimmer },
    { name: 'stub', available: () => true, explicitOnly: true, port: stubTrimmer },
];

const WAVEFORMS: ProviderEntry<WaveformPort>[] = [
    { name: 'ffmpeg', available: ffmpegAvailable, port: ffmpegWaveform },
    { name: 'stub', available: () => true, explicitOnly: true, port: stubWaveform },
];

/**
 * Resolve one stage's provider.
 *
 * With no env var set, scans for the first available entry — which reproduces
 * the previous behavior exactly, since the only implicit entries are the ones
 * the old branches wired.
 *
 * With an env var set, an unavailable or unknown value is treated as a
 * MISCONFIGURATION rather than an opt-out: it logs and the stage goes
 * unavailable, and it deliberately does NOT fall through to the next entry.
 * Same call this seam already makes for partial Cloud Tasks config — an
 * operator who named a provider believes they have it, and falling through
 * would overrule their explicit choice without a word. The stage resolving
 * unavailable is the recoverable outcome: `resolveInitialProcessing` settles it
 * `skipped` rather than failing posts one at a time against a provider that was
 * never going to answer.
 */
function select<T>(entries: ProviderEntry<T>[], envVar: string): T | undefined {
    const requested = process.env[envVar]?.trim().toLowerCase();
    if (!requested) return entries.find((entry) => !entry.explicitOnly && entry.available())?.port;

    const entry = entries.find((candidate) => candidate.name === requested);
    if (!entry) {
        logger.error(
            { envVar, requested, known: entries.map((candidate) => candidate.name) },
            '[audio-processing] unknown provider requested — stage disabled',
        );
        return undefined;
    }
    if (!entry.available()) {
        logger.error(
            { envVar, requested },
            '[audio-processing] provider requested but not configured — stage disabled',
        );
        return undefined;
    }
    return entry.port;
}

/** The transcriber this deployment runs, or undefined when the stage is unavailable. */
export function selectTranscriber(): TranscriberPort | undefined {
    return select(TRANSCRIBERS, 'ANTIPHONY_TRANSCRIBER');
}

/** The denoiser this deployment runs, or undefined when the stage is unavailable. */
export function selectDenoiser(): DenoiserPort | undefined {
    return select(DENOISERS, 'ANTIPHONY_DENOISER');
}

/** The trimmer this deployment runs, or undefined when the stage is unavailable. */
export function selectTrimmer(): TrimmerPort | undefined {
    return select(TRIMMERS, 'ANTIPHONY_TRIMMER');
}

/** The waveform provider this deployment runs, or undefined when unavailable. */
export function selectWaveform(): WaveformPort | undefined {
    return select(WAVEFORMS, 'ANTIPHONY_WAVEFORM');
}
