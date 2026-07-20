import type { ProcessingStage, ProcessingStageStatus } from 'shared/types/processing';

/**
 * ProcessingNotifierPort — the outbound seam for pushing "a stage just settled"
 * at the tenant, the core→BFF direction. See `specs/enrichment-webhooks.md`.
 *
 * **Why a port, and why here.** Enrichment settles out of band from the create/
 * PATCH that requested it, so a BFF otherwise learns a stage finished only by
 * PULLING — polling the post view or waiting for the reconciliation sweep. This
 * port lets `AudioProcessingService` PUSH the result the moment it settles. It
 * is invoked at the single place each stage settles (`process()`), so every
 * dispatcher — inline, Cloud Tasks, future Cloudflare — inherits it, exactly as
 * the lease does; the hazard-and-signal belongs to `process()`, not a transport.
 *
 * **Firebase-free, like every other port here.** The concrete HTTP + HMAC
 * adapter lives in `apps/core-api/src/adapters/outbound/webhook/`; a deployment
 * with no notifier wired passes a noop and nothing changes.
 *
 * **An accelerator, never a source of truth.** The authoritative record of
 * enrichment state is the post's `processing` map, already committed to
 * Firestore before any notify fires. A dropped notification is a LATENCY
 * regression (the BFF learns later, via its next GET or the sweep), never a
 * correctness bug — which is what justifies best-effort delivery: the service
 * logs and swallows a failed `notify` rather than failing the stage. An
 * implementation therefore MUST NOT throw in a way the caller relies on, but
 * the caller guards anyway.
 */

/**
 * One stage reaching a TERMINAL state. `pending` never fires — it is not a
 * settle — so the status is narrowed to the three terminal values.
 *
 * Self-sufficient by design: `{postId, stage, status}` is enough for the BFF to
 * act without a follow-up "what happened" request. It fetches the artifact
 * (transcript, signed URL, peaks) from the view only when the status says one
 * is worth fetching, on its own terms.
 */
export interface StageSettledEvent {
    /** The tenant. A multi-tenant receiver routes on it; a single-tenant one ignores it. */
    originAppId: string;
    postId: string;
    stage: ProcessingStage;
    /** The terminal states only — `pending` is not a settle and never fires. */
    status: Exclude<ProcessingStageStatus, 'pending'>;
    /**
     * Server settle time (ISO-8601), so a receiver can order events and detect
     * a stale/replayed delivery. Recompute legitimately settles a derived stage
     * twice (`ready → pending → ready`); the second is a NEW correct event, so a
     * receiver dedupes "latest wins for (postId, stage)" with `occurredAt` as
     * the tiebreaker — not "ignore if seen".
     */
    occurredAt: string;
}

export interface ProcessingNotifierPort {
    /**
     * Announce that a stage settled. Best-effort by contract: resolves on
     * delivery, may reject on transport failure, and the caller logs-and-swallows
     * either way. Never call before the settling Firestore write has committed —
     * ordering the write first means a crash between them loses a notification,
     * not a result.
     */
    notify(event: StageSettledEvent): Promise<void>;
}

/**
 * The do-nothing notifier — the default when no tenant webhook is wired. Its
 * presence is what lets `AudioProcessingService` take the notifier as a
 * non-optional dependency while every existing call site stays a no-op until a
 * real adapter is injected.
 */
export const noopNotifier: ProcessingNotifierPort = {
    async notify(): Promise<void> {},
};
