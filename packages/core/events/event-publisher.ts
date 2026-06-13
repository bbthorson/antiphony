import type { PromptRecord, ReplyRecord, UserRecord } from 'shared/types/records';
import type { OrganizationRecord } from 'shared/types/records';

/**
 * EventPublisher is the contract between core and the hosted enrichment
 * tier. Core emits domain events when records are created or meaningfully
 * change; hosted subscribes and runs enrichment (transcription, voice
 * isolation, scoring, social video, etc.).
 *
 * Named but not yet wired. The current production implementation is
 * **implicit**: a Firestore write IS the event, and hosted code (in
 * `functions/`) subscribes via Firestore triggers. This interface will
 * become load-bearing when one of the following forces the transport
 * decision:
 *
 * 1. **Core extraction** (Phase 4) — once core runs as its own deployment,
 *    Firestore triggers no longer bridge the two tiers and an explicit
 *    transport (pub/sub, webhooks, LISTEN/NOTIFY, etc.) has to land.
 * 2. **Second hosted enrichment** — a second subscriber wanting different
 *    delivery semantics (retries, ordering, fan-out) from the default.
 * 3. **Self-hosted contributors on Postgres** — Firestore triggers
 *    obviously don't exist there; the impl needs to be swappable.
 *
 * Until then, leaving this interface **unimplemented by core code** is a
 * feature: it preserves the freedom to pick a transport when the real
 * constraints appear, rather than committing to one speculatively.
 *
 * See `specs/decoupling-migration.md` — Phase 2 exit, and the
 * "Event mechanism post-Firestore" open question.
 */

export type CoreEvent =
    | { type: 'prompt.created'; at: Date; record: PromptRecord }
    | { type: 'prompt.updated'; at: Date; record: PromptRecord; previous: PromptRecord }
    | { type: 'reply.created'; at: Date; record: ReplyRecord }
    | { type: 'reply.updated'; at: Date; record: ReplyRecord; previous: ReplyRecord }
    | { type: 'user.created'; at: Date; record: UserRecord }
    | { type: 'organization.created'; at: Date; record: OrganizationRecord };

/**
 * Core-tier services call `publish` after a state change worth broadcasting.
 * Delivery is fire-and-forget from the core's perspective: if the publisher
 * fails, the core write has already succeeded — hosted consumers must be
 * idempotent.
 *
 * Ordering is not guaranteed across different aggregate roots (e.g., a
 * reply event may arrive before the prompt it replies to in pathological
 * cases). Consumers that need strict ordering should resolve it from the
 * records themselves, not from delivery order.
 */
export interface EventPublisher {
    publish(event: CoreEvent): Promise<void>;
}

/**
 * No-op implementation — for the current production topology, where hosted
 * subscribes to Firestore triggers directly and no explicit publish call
 * from core is needed. Also useful in tests that don't care about the
 * event surface.
 *
 * When explicit event dispatch lands, this stops being the default.
 */
export const noopEventPublisher: EventPublisher = {
    async publish() {
        // Intentionally empty — today's topology fires events via Firestore
        // triggers directly, so core doesn't need to publish anything.
    },
};
