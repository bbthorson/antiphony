import {
    capabilitiesOf,
    type ProcessingCapabilities,
    type ProcessingProviders,
} from '@antiphony/core/services/audio-processing';
import type { ProcessingDispatchPort } from '@antiphony/core/ports/processing-dispatch';
import type { ProcessingNotifierPort } from '@antiphony/core/ports/processing-notifier';
import {
    PROCESSING_STAGES,
    type ProcessingRequest,
    type ProcessingStageMap,
    type ResolvedProcessing,
} from 'shared/types/processing';
import { servicesFor } from '../composition.js';
import {
    stubTranscriber,
    stubDenoiser,
    stubTrimmer,
    stubWaveform,
} from '../adapters/outbound/processing/providers.js';
import {
    selectTranscriber,
    selectDenoiser,
    selectTrimmer,
    selectWaveform,
} from './provider-registry.js';
import { inlineDispatcher } from '../adapters/outbound/dispatch/inline.js';
import { webhookNotifier } from '../adapters/outbound/webhook/notifier.js';
import { noopDispatcher } from '../adapters/outbound/dispatch/noop.js';
import { logger } from './logger.js';

/**
 * Composition + dispatch seam for audio processing (B5).
 *
 * Resolved per-request off env (like `getOriginAppId`) so tests and per-env
 * config take effect without a module-load singleton:
 *   - `ANTIPHONY_PROCESSING_STUB=true`   → wire the stub providers (dev/tests).
 *   - `ANTIPHONY_{TRANSCRIBER,DENOISER,TRIMMER,WAVEFORM}` → name one stage's
 *     provider explicitly. Unset (the normal case) selects the first available
 *     one, which is what every existing deployment already gets. See
 *     `provider-registry.ts`.
 *   - `ANTIPHONY_PROCESSING_INLINE=true` → wire the inline dispatcher, which
 *     runs processing synchronously inside the request. This is the local/test
 *     trigger.
 *   - Otherwise, if the `ANTIPHONY_TASKS_*` vars are set → the Cloud Tasks
 *     dispatcher, which enqueues against this deployment's own
 *     `/api/v1/system/process-audio` worker. This is production.
 *   - With neither → the noop dispatcher logs and drops.
 *
 * Note the two flags govern DIFFERENT axes and neither implies the other:
 * `_STUB` decides which providers can do the work, `_INLINE` decides who runs
 * it. A deployment with real providers and no dispatcher has capable stages
 * and nowhere to run them — that is the case the noop dispatcher logs.
 */

/**
 * Which stages this deployment can actually perform right now. Defined in core
 * alongside `capabilitiesOf`; re-exported here so existing importers of this
 * module are unaffected.
 */
export type { ProcessingCapabilities };

/**
 * Exported for the queue worker route, which builds its own
 * `AudioProcessingService` outside any request that resolved providers already.
 * Still called per invocation rather than memoized — see the module docstring.
 */
export function resolveProviders(originAppId?: string): ProcessingProviders {
    // Stub wins when explicitly set, so a dev/test env with a real key lying
    // around in the shell cannot accidentally bill a live provider. Still a
    // wholesale override, ahead of any per-stage selection: the per-stage
    // `stub` names in the registry are for mixing one stub into an otherwise
    // real deployment, not for expressing this.
    if (process.env.ANTIPHONY_PROCESSING_STUB === 'true') {
        return {
            transcriber: stubTranscriber,
            denoiser: stubDenoiser,
            trimmer: stubTrimmer,
            waveform: stubWaveform,
        };
    }

    // Each stage selects independently — tenant pin, then deployment default,
    // then the first available provider (see `provider-registry.ts`). Real
    // providers still select off their API key alone, with no separate enable
    // flag to keep in sync with it: key present ⇒ the stage is available.
    //
    // `originAppId` omitted resolves the DEPLOYMENT-wide wiring, skipping the
    // tenant layer entirely. Every caller in the request path passes it; the
    // parameter is optional only so a caller genuinely outside a tenancy has a
    // meaningful answer rather than having to invent an app id.
    //
    // An absent stage is `undefined` rather than an omitted key, which is the
    // same thing to `capabilitiesOf` (it tests truthiness) and to every
    // consumer of `ProcessingProviders`, whose fields are all optional.
    return {
        transcriber: selectTranscriber(originAppId),
        denoiser: selectDenoiser(originAppId),
        trimmer: selectTrimmer(originAppId),
        waveform: selectWaveform(originAppId),
    };
}

/**
 * Which stages this TENANT can actually perform right now.
 *
 * Tenant-scoped, not deployment-scoped, because provider selection is: a tenant
 * pinned to a provider this deployment cannot run has that stage unavailable
 * while its neighbours still do. Answering deployment-wide here would advertise
 * a stage the pinned tenant can never get, and `resolveInitialProcessing` would
 * store `pending` for work nothing will ever perform.
 *
 * Delegates to `capabilitiesOf` rather than mapping providers to stages again:
 * `AudioProcessingService` filters its recompute set through the same function,
 * and a second copy here would let the two disagree — a stage advertised as
 * runnable but never recomputed serves a permanently stale artifact under a
 * `ready` status.
 */
export function processingCapabilities(originAppId?: string): ProcessingCapabilities {
    return capabilitiesOf(resolveProviders(originAppId));
}

/**
 * Resolve an app's opt-in request into the initial per-stage state to store:
 * `pending` when this tenant can do it, `skipped` when it can't. Returns
 * undefined when nothing was requested.
 */
export function resolveInitialProcessing(
    originAppId: string,
    request: ProcessingRequest | undefined,
): ResolvedProcessing | undefined {
    if (!request || !PROCESSING_STAGES.some((stage) => request[stage])) return undefined;
    const caps = processingCapabilities(originAppId);
    const state: ResolvedProcessing = {};
    for (const stage of PROCESSING_STAGES) {
        if (request[stage]) state[stage] = caps[stage] ? 'pending' : 'skipped';
    }
    // Always written, including the default. `setProcessing` MERGES onto the
    // stored state, so omitting it would let an earlier request's `false`
    // silently govern a later request that never asked to opt out. Absent
    // remains true for posts written before this field existed.
    state.reprocess = request.reprocess !== false;
    return state;
}

/** True when at least one stage still needs work (i.e. dispatch is worthwhile). */
export function hasPendingStage(state: ProcessingStageMap | undefined): boolean {
    return !!state && PROCESSING_STAGES.some((stage) => state[stage] === 'pending');
}

/**
 * The outbound stage-settled notifier for this deployment. Always the webhook
 * adapter: it resolves each tenant's `{url, secret}` per event and no-ops for a
 * tenant with none configured, so a deployment with no webhooks wired needs no
 * separate branch here — absence is handled tenant-by-tenant inside the adapter.
 *
 * Resolved per-invocation (like `resolveProviders`) so env-driven config takes
 * effect in tests and across restarts without a module-load singleton. The
 * worker route builds its own `AudioProcessingService` and calls this directly.
 */
export function resolveNotifier(): ProcessingNotifierPort {
    return webhookNotifier(logger);
}

/**
 * The durable dispatcher for this runtime, if it has one.
 *
 * Installed rather than imported, for the same reason the Firebase bindings are
 * (see `composition.ts` § Why the Firebase half is injected): the Cloud Tasks
 * adapter reaches `google-auth-library`, which a Worker bundle cannot carry —
 * and would have no use for, since a Worker has no Application Default
 * Credentials to authenticate an enqueue with.
 *
 * Returns `undefined` when this deployment has no durable dispatch configured.
 * The resolver owns its OWN misconfiguration reporting: whether a partial
 * config counts as an opt-out or an outage is a property of the queue being
 * configured, not of this seam, and the two adapters answer it differently —
 * Cloud Tasks reads four env vars that can disagree, a Queues binding is simply
 * present or absent.
 *
 * Takes `env` because a Worker's bindings arrive on the invocation, not at
 * module load, so `PROCESSING_QUEUE` cannot be closed over. The Cloud Tasks
 * resolver ignores the argument and reads `process.env`, which is the shape of
 * the whole runtime split.
 */
export type DurableDispatcherResolver = (
    env?: Record<string, unknown>,
) => ProcessingDispatchPort | undefined;

let resolveDurableDispatcher: DurableDispatcherResolver | undefined;

/** Register this runtime's durable dispatcher resolver. See the type above. */
export function installDurableDispatcher(resolver: DurableDispatcherResolver): void {
    resolveDurableDispatcher = resolver;
}

/**
 * Which dispatcher this deployment runs jobs through. Resolved per-request off
 * env, like `resolveProviders`, so a test can set the flag without a
 * module-load singleton fixing the choice at import time.
 *
 * Takes the tenant because the INLINE dispatcher wires providers eagerly, and
 * those must be the tenant's. The queue dispatchers do not: they only enqueue,
 * and the worker resolves providers for itself on the far side of the queue.
 */
function resolveDispatcher(
    originAppId: string,
    env?: Record<string, unknown>,
): ProcessingDispatchPort {
    // Inline wins, so a developer with queue config in their shell cannot
    // accidentally enqueue against a real queue from a local run — the same
    // precedence, and the same reasoning, as `_STUB` over real providers.
    if (process.env.ANTIPHONY_PROCESSING_INLINE === 'true') {
        return inlineDispatcher(
            servicesFor(env).audioProcessingDeps,
            resolveProviders(originAppId),
            logger,
            resolveNotifier(),
        );
    }

    return resolveDurableDispatcher?.(env) ?? noopDispatcher(logger);
}

/**
 * Dispatch processing for a post whose state has already been persisted.
 *
 * **Never throws.** The post is committed by the time this is called and the
 * response has to succeed regardless: a create that 500s because a queue was
 * briefly unreachable would leave the caller retrying a write that already
 * landed. The failure is logged and the stages stay `pending`.
 *
 * Leaving them `pending` is deliberate. It is the truthful state — the work
 * was not attempted — and it stays recoverable, where marking them `failed`
 * would record a permanent verdict about a transient outage. The cost is that
 * nothing currently re-drives a post whose dispatch failed; closing that needs
 * a reconciliation sweep over `pending` posts, which is its own piece of work
 * and is not part of this seam.
 */
export async function dispatchProcessing(
    originAppId: string,
    postId: string,
    env?: Record<string, unknown>,
): Promise<void> {
    try {
        await resolveDispatcher(originAppId, env).dispatch({ originAppId, postId });
    } catch (err) {
        logger.error({ err, postId, originAppId }, '[audio-processing] dispatch failed');
    }
}
