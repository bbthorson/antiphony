import { createHmac } from 'node:crypto';
import type { Logger } from '@antiphony/core/ports/logger';
import type {
    ProcessingNotifierPort,
    StageSettledEvent,
} from '@antiphony/core/ports/processing-notifier';
import type { DeletionNotifierPort, PostDeletedEvent } from '@antiphony/core/ports/deletion-notifier';
import { resolveWebhookConfig, type WebhookConfig } from '../../../lib/webhook-config.js';

/**
 * HTTP + HMAC webhook notifier — the concrete `ProcessingNotifierPort` that
 * POSTs a `StageSettledEvent` to the settling tenant's configured URL, signed
 * with HMAC-SHA256 over the raw body (`specs/enrichment-webhooks.md`).
 *
 * **Best-effort, and safe to drop.** The authoritative state is already in
 * Postgres before `AudioProcessingService.settle` calls this; a failed POST is
 * a latency regression the sweep/next-GET backstops, never lost truth. So this
 * bounds itself (a short timeout, a couple of quick retries) and, on final
 * failure, logs and RESOLVES — the service also guards, but the adapter should
 * not lean on that to swallow ordinary network noise.
 *
 * **Two event types, one channel.** Stage events and `post.deleted` events
 * (specs/deletion.md § 8) go to the same URL with the same signature, and carry
 * a `type` so a receiver can tell them apart.
 *
 * **Silent per-tenant opt-out.** A tenant with no `{url, secret}` (or partial
 * config, already logged at parse) resolves to nothing here and simply gets no
 * POST — the pull paths still carry the result.
 */

/** Short per-attempt timeout — a slow receiver must not stall the pass. */
const TIMEOUT_MS = 3000;

/** Total attempts: the first plus two quick retries on transient failure. */
const MAX_ATTEMPTS = 3;

/** Fixed pause between attempts. Small so a doomed delivery gives up promptly. */
const RETRY_BACKOFF_MS = 200;

export function webhookNotifier(
    logger: Logger,
    // Injected so the adapter's tests can assert the signed request it builds
    // without a live listener, mirroring `cloudTasksDispatcher`. Production
    // passes nothing.
    fetchImpl: typeof fetch = fetch,
    // Injected only so tests exercise the retry path without real wall-clock
    // delay; production uses the real timer.
    sleep: (ms: number) => Promise<void> = defaultSleep,
): ProcessingNotifierPort & DeletionNotifierPort {
    return {
        async notify(event: StageSettledEvent): Promise<void> {
            const config = resolveWebhookConfig(event.originAppId);
            if (!config) return; // no webhook for this tenant → nothing to do
            await deliver(
                config,
                {
                    type: 'stage.settled',
                    postId: event.postId,
                    originAppId: event.originAppId,
                    stage: event.stage,
                    status: event.status,
                    occurredAt: event.occurredAt,
                },
                {
                    eventId: `${event.postId}:${event.stage}:${event.status}`,
                    timestamp: event.occurredAt,
                    context: { originAppId: event.originAppId, postId: event.postId, stage: event.stage },
                    label: 'stage-settled',
                },
                logger,
                fetchImpl,
                sleep,
            );
        },

        async notifyDeleted(event: PostDeletedEvent): Promise<void> {
            const config = resolveWebhookConfig(event.originAppId);
            if (!config) return;
            await deliver(
                config,
                {
                    type: 'post.deleted',
                    originAppId: event.originAppId,
                    postId: event.postId,
                    uri: event.uri,
                    kind: event.kind,
                    occurredAt: event.occurredAt,
                },
                {
                    // A post is deleted once, so its id names the event.
                    eventId: `${event.postId}:deleted`,
                    timestamp: event.occurredAt,
                    context: { originAppId: event.originAppId, postId: event.postId },
                    label: 'post-deleted',
                },
                logger,
                fetchImpl,
                sleep,
            );
        },
    };
}

interface Delivery {
    eventId: string;
    timestamp: string;
    /** Log fields identifying the event. */
    context: Record<string, string>;
    /** How the logs name the event. */
    label: string;
}

async function deliver(
    config: WebhookConfig,
    payload: Record<string, unknown>,
    delivery: Delivery,
    logger: Logger,
    fetchImpl: typeof fetch,
    sleep: (ms: number) => Promise<void>,
): Promise<void> {
    // The signed bytes ARE the payload the receiver recomputes over, so the
    // body is serialized once and both signed and sent verbatim — re-serializing
    // per attempt would risk a signature that doesn't match the bytes on the wire.
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', config.secret).update(body).digest('hex')}`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const res = await fetchImpl(config.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Antiphony-Signature': signature,
                    'X-Antiphony-Event-Id': delivery.eventId,
                    'X-Antiphony-Timestamp': delivery.timestamp,
                },
                body,
                redirect: 'manual',
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (res.ok) return;
            // A 4xx is the receiver rejecting the request itself (bad signature,
            // unknown route) — retrying the same bytes cannot fix it, so stop.
            // The two transient exceptions are 429 (rate-limited) and 408
            // (request timeout): the same bytes CAN succeed once the receiver
            // recovers, so they fall through to retry alongside 5xx.
            // A 5xx is a transient server-side failure worth another attempt.
            const transient = res.status >= 500 || res.status === 429 || res.status === 408;
            if (!transient) {
                logger.error(
                    { ...delivery.context, status: res.status },
                    `[webhook] receiver rejected ${delivery.label} webhook (4xx); not retrying`,
                );
                return;
            }
            if (attempt === MAX_ATTEMPTS) {
                logger.error(
                    { ...delivery.context, status: res.status, attempts: attempt },
                    `[webhook] ${delivery.label} webhook failed after retries (transient status); dropped`,
                );
                return;
            }
        } catch (err) {
            // Network error or timeout (AbortSignal). Transient — retry until the
            // budget is spent, then drop with a log.
            if (attempt === MAX_ATTEMPTS) {
                logger.error(
                    { err, ...delivery.context, attempts: attempt },
                    `[webhook] ${delivery.label} webhook failed after retries; dropped`,
                );
                return;
            }
        }
        await sleep(RETRY_BACKOFF_MS);
    }
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
