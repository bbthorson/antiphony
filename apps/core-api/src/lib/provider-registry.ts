import type { TranscriberPort } from '@antiphony/core/ports/transcription';
import type { DenoiserPort } from '@antiphony/core/ports/audio-denoiser';
import type { TrimmerPort } from '@antiphony/core/ports/audio-trimmer';
import type { WaveformPort } from '@antiphony/core/ports/audio-waveform';
import {
    stubTranscriber,
    stubDenoiser,
    stubTrimmer,
    stubWaveform,
} from '../adapters/outbound/processing/providers.js';
import { elevenLabsApiKey } from '../adapters/outbound/elevenlabs/client.js';
import { elevenLabsTranscriber } from '../adapters/outbound/elevenlabs/transcriber.js';
import { elevenLabsDenoiser } from '../adapters/outbound/elevenlabs/denoiser.js';
import { renditionServiceConfig } from '../adapters/outbound/rendition/http.js';
import { httpTrimmer, httpWaveform } from '../adapters/outbound/rendition/stages.js';
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

// Trim and waveform are the two stages that need ffmpeg, and neither can run
// in-process any more: a Worker cannot spawn a subprocess. Both now go over HTTP
// to `apps/audio-rendition`, which is why their availability is the same
// question — "is a transcode backend configured" — rather than the old "is a
// binary present".
//
// That coupling is real (one service, two stages) and is expressed by sharing
// `renditionServiceConfig()`, not by sharing a branch, so the two remain
// independently selectable. Unconfigured, both resolve unavailable and
// `resolveInitialProcessing` settles them `skipped` — the same honest state the
// old missing-binary case produced.
//
// Note this REPLACED an install seam. While these adapters reached
// `node:child_process` they had to be injected by the Node entry point, because
// importing them would have put `ffmpeg-static` in the Worker bundle. A `fetch`
// is portable, so the entries live here like every other one.
const stageBackend = () => !!renditionServiceConfig().config;

/** The configured backend, or a throw — guarded by `available()` at every call site. */
function stageConfig() {
    const resolved = renditionServiceConfig();
    if (!resolved.config) {
        throw new Error('[provider-registry] no transcode backend configured for this stage');
    }
    return resolved.config;
}

const TRIMMERS: ProviderEntry<TrimmerPort>[] = [
    {
        name: 'service',
        available: stageBackend,
        create: () => httpTrimmer(stageConfig(), logger),
    },
    { name: 'stub', available: () => true, explicitOnly: true, create: () => stubTrimmer },
];

const WAVEFORMS: ProviderEntry<WaveformPort>[] = [
    {
        name: 'service',
        available: stageBackend,
        create: () => httpWaveform(stageConfig(), logger),
    },
    { name: 'stub', available: () => true, explicitOnly: true, create: () => stubWaveform },
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
