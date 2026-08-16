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
import {
    TENANT_MODEL_VARS,
    TENANT_PROVIDER_VARS,
    tenantModel,
    tenantProvider,
    type TenantModelStage,
    type TenantProviderStage,
} from './tenant-provider-config.js';
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
 * Selection resolves in three layers, narrowest first:
 *
 *   1. **Tenant** — `ANTIPHONY_APP_TRANSCRIBERS` and friends, `appId:provider`
 *      (see `tenant-provider-config.ts`), plus `ANTIPHONY_APP_STT_MODELS` for
 *      the model.
 *   2. **Deployment** — `ANTIPHONY_TRANSCRIBER` and friends.
 *   3. **Scan** — the first available non-`explicitOnly` entry.
 *
 * All three are OPS config read off env. Nothing here is request-scoped: a
 * tenant cannot name a provider or model over the API, so it can never invoke
 * an arbitrary expensive model on the deployment's key. See
 * `specs/provider-selection.md` § 5.
 *
 * Nothing here leaks upward. `@antiphony/core` still sees only the four ports,
 * and vendor concepts — model names, endpoints, error codes — stay inside the
 * adapters, per `specs/enrichment-pipeline.md` § Provider policy.
 */

export interface ProviderEntry<T> {
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
    /**
     * Build the port, optionally bound to a specific model.
     *
     * A factory rather than a fixed instance so a tenant's model can be closed
     * over at WIRING time. That is what keeps per-tenant model selection inside
     * the provider policy: the model never crosses the port, so
     * `@antiphony/core` still names no vendor model.
     */
    create(model?: string): T;
    /**
     * Whether `create` does anything with `model`. Entries without it reject a
     * tenant model override loudly instead of accepting one it would ignore —
     * silence there leaves an operator believing a tenant runs a model it never
     * sees, the same class of lie as a capability that advertises `true` and
     * fails every post.
     */
    readonly acceptsModel?: true;
}

/**
 * Order matters: the default scan takes the first AVAILABLE non-explicitOnly
 * entry, so these lists are preference order for a deployment that names no
 * provider.
 */

const TRANSCRIBERS: ProviderEntry<TranscriberPort>[] = [
    {
        name: 'elevenlabs',
        available: () => !!elevenLabsApiKey(),
        create: (model) => elevenLabsTranscriber(model),
        acceptsModel: true,
    },
    { name: 'stub', available: () => true, explicitOnly: true, create: () => stubTranscriber },
];

// No `acceptsModel`: `/audio-isolation` takes no `model_id`, so there is
// nothing to select between and a tenant naming one is told rather than
// silently ignored.
const DENOISERS: ProviderEntry<DenoiserPort>[] = [
    { name: 'elevenlabs', available: () => !!elevenLabsApiKey(), create: () => elevenLabsDenoiser },
    { name: 'stub', available: () => true, explicitOnly: true, create: () => stubDenoiser },
];

// Trim and waveform are LOCAL compute — no API key, so they are available on
// their binary alone, and one probe governs both. That coupling is real (one
// ffmpeg, two stages) and survives the split below: `native-providers.ts`
// still builds both entries from the SAME `ffmpegAvailable` probe, so the two
// stages remain independently selectable without being independently probed.
//
// The ffmpeg entries are NOT declared here. They reach `node:child_process` and
// `ffmpeg-static`, neither of which exists on Workers — `nodejs_compat` does
// not provide `child_process`, and `ffmpeg-static` resolves its binary through
// `__dirname` at module scope. `src/native.ts` installs them under Node. On a
// Worker the arrays below are all there is, so trim and waveform resolve
// unavailable and `resolveInitialProcessing` settles them `skipped` — which is
// the truthful state until step 4 moves those stages onto the rendition
// service. See specs/cloudflare-migration.md § The ffmpeg problem.
const TRIMMERS: ProviderEntry<TrimmerPort>[] = [
    { name: 'stub', available: () => true, explicitOnly: true, create: () => stubTrimmer },
];

const WAVEFORMS: ProviderEntry<WaveformPort>[] = [
    { name: 'stub', available: () => true, explicitOnly: true, create: () => stubWaveform },
];

/**
 * The stage adapters that only a Node runtime can run. Installed at import time
 * by `src/native.ts`; absent on Workers.
 */
export interface NativeProviders {
    trimmer: ProviderEntry<TrimmerPort>;
    waveform: ProviderEntry<WaveformPort>;
}

/**
 * Register a native entry ahead of the stub, or replace an already-registered
 * one of the same name.
 *
 * Order matters — the default scan takes the first available non-`explicitOnly`
 * entry — so a native adapter has to land in FRONT of the list, not appended to
 * it. Replacing by name rather than always prepending keeps a second call
 * idempotent, which matters because a test that re-imports the entry point
 * would otherwise stack duplicate entries and make the scan's result depend on
 * how many times the module was loaded.
 */
function installEntry<T>(entries: ProviderEntry<T>[], entry: ProviderEntry<T>): void {
    const existing = entries.findIndex((candidate) => candidate.name === entry.name);
    if (existing >= 0) entries[existing] = entry;
    else entries.unshift(entry);
}

/** Wire the Node-only stage adapters into the registry. See `NativeProviders`. */
export function installNativeProviders(native: NativeProviders): void {
    installEntry(TRIMMERS, native.trimmer);
    installEntry(WAVEFORMS, native.waveform);
}

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
function select<T>(
    entries: ProviderEntry<T>[],
    stage: TenantProviderStage,
    envVar: string,
    originAppId: string | undefined,
): T | undefined {
    const model = resolveTenantModel(stage, originAppId);

    // Tenant override wins over the deployment default, which wins over the
    // scan. Three layers, each one narrower than the last, and each one
    // explicit — so a tenant's pin is never quietly overruled by a deployment
    // default someone changed later.
    const tenantChoice = originAppId ? tenantProvider(stage, originAppId) : undefined;
    const requested = (tenantChoice ?? process.env[envVar])?.trim().toLowerCase();
    // Reported on every failure below, so a log line says WHICH layer chose the
    // provider that could not be wired.
    const source = tenantChoice ? TENANT_PROVIDER_VARS[stage] : envVar;

    if (!requested) {
        const entry = entries.find((candidate) => !candidate.explicitOnly && candidate.available());
        return entry ? build(entry, stage, model, originAppId) : undefined;
    }

    const entry = entries.find((candidate) => candidate.name === requested);
    if (!entry) {
        logger.error(
            { source, originAppId, requested, known: entries.map((candidate) => candidate.name) },
            '[audio-processing] unknown provider requested — stage disabled',
        );
        return undefined;
    }
    if (!entry.available()) {
        logger.error(
            { source, originAppId, requested },
            '[audio-processing] provider requested but not configured — stage disabled',
        );
        return undefined;
    }
    return build(entry, stage, model, originAppId);
}

/**
 * Build the port, reporting a tenant model aimed at an entry that has no model
 * to set.
 *
 * The stage still runs — an ignorable model is not a reason to deny a tenant
 * transcription — but it runs on the provider's own default, and the operator
 * is told rather than left believing the pin took effect.
 */
function build<T>(
    entry: ProviderEntry<T>,
    stage: TenantProviderStage,
    model: string | undefined,
    originAppId: string | undefined,
): T {
    if (model !== undefined && !entry.acceptsModel) {
        logger.error(
            { stage, originAppId, provider: entry.name, model },
            '[audio-processing] tenant names a model for a provider that has none — ignored, the provider default is used',
        );
    }
    return entry.create(entry.acceptsModel ? model : undefined);
}

/** This tenant's model for a stage, when the stage has a model var at all. */
function resolveTenantModel(
    stage: TenantProviderStage,
    originAppId: string | undefined,
): string | undefined {
    if (!originAppId || !isModelStage(stage)) return undefined;
    return tenantModel(stage, originAppId);
}

function isModelStage(stage: TenantProviderStage): stage is TenantModelStage {
    return stage in TENANT_MODEL_VARS;
}

/** The transcriber this tenant runs, or undefined when the stage is unavailable. */
export function selectTranscriber(originAppId?: string): TranscriberPort | undefined {
    return select(TRANSCRIBERS, 'transcribe', 'ANTIPHONY_TRANSCRIBER', originAppId);
}

/** The denoiser this tenant runs, or undefined when the stage is unavailable. */
export function selectDenoiser(originAppId?: string): DenoiserPort | undefined {
    return select(DENOISERS, 'denoise', 'ANTIPHONY_DENOISER', originAppId);
}

/** The trimmer this tenant runs, or undefined when the stage is unavailable. */
export function selectTrimmer(originAppId?: string): TrimmerPort | undefined {
    return select(TRIMMERS, 'trim', 'ANTIPHONY_TRIMMER', originAppId);
}

/** The waveform provider this tenant runs, or undefined when unavailable. */
export function selectWaveform(originAppId?: string): WaveformPort | undefined {
    return select(WAVEFORMS, 'waveform', 'ANTIPHONY_WAVEFORM', originAppId);
}
