import { z } from 'zod';
import { StrongRefSchema } from './audio';
import { ProcessingStageSchema, ProcessingStageStatusSchema } from './processing';
import { RemoteSpaceUriSchema } from './remote-posts';

/**
 * **Webhook payloads** (`specs/enrichment-webhooks.md`).
 *
 * Antiphony POSTs signed JSON to a tenant's one configured URL. Five event
 * types share it; every body carries a `type` that says which. These schemas
 * describe the body exactly as `apps/core-api`'s notifier sends it, and that
 * sender is typed against them, so a payload field cannot change without this
 * file changing with it.
 *
 * **Parsing is loose on purpose.** The schemas are plain `z.object`s, which
 * IGNORE keys they do not know (they are dropped from the parsed value, never
 * a failure). A later release may add a field to an event; a receiver built
 * today must keep working. Do not switch them to `.strict()`.
 *
 * Verify the signature first (`verifyWebhookSignature`, in `utils/`), then
 * parse: the signature covers the raw body bytes, and nothing in a body is
 * trustworthy until it checks out.
 */

/** Request header carrying `sha256=<hex>`, the HMAC-SHA256 of the raw body. Signed material is the body only. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Antiphony-Signature';

/**
 * Request header carrying the event's `occurredAt`. NOT signed: judge
 * staleness from `occurredAt` in the signed body, never from this header.
 */
export const WEBHOOK_TIMESTAMP_HEADER = 'X-Antiphony-Timestamp';

/**
 * Request header naming the event. NOT signed, and not unique per delivery: a
 * recompute legitimately re-fires the same id, so it is not a replay key. The
 * form per event type is in `specs/enrichment-webhooks.md` (Auth).
 */
export const WEBHOOK_EVENT_ID_HEADER = 'X-Antiphony-Event-Id';

/** An at:// URI, as the notifier sends it for a hosted or a remote post. */
const PostUriSchema = StrongRefSchema.shape.uri;

/** Fields every event carries: the tenant, and the server time of the event (ISO-8601, UTC). */
const base = {
    originAppId: z.string().min(1),
    occurredAt: z.iso.datetime(),
};

/**
 * A processing stage reached a terminal state. `pending` is not a settle and
 * never fires, so it is refused here. Recompute legitimately settles a derived
 * stage twice (`ready → pending → ready`); dedupe latest-wins per
 * `(uri, stage)` with `occurredAt` as the tiebreaker, not "seen before".
 */
export const StageSettledWebhookSchema = z.object({
    type: z.literal('stage.settled'),
    /** The hosted post's id. Absent for a remote post, whose record key alone is not unique; key on `uri`. */
    postId: z.string().min(1).optional(),
    uri: PostUriSchema,
    stage: ProcessingStageSchema,
    status: ProcessingStageStatusSchema.exclude(['pending']),
    ...base,
});
export type StageSettledWebhook = z.infer<typeof StageSettledWebhookSchema>;

/** A post was deleted. It happens once, so seeing it twice is a duplicate. */
export const PostDeletedWebhookSchema = z.object({
    type: z.literal('post.deleted'),
    postId: z.string().min(1),
    /** The URI the post had, as the deletion ledger kept it. */
    uri: PostUriSchema,
    kind: z.enum(['prompt', 'reply']),
    ...base,
});
export type PostDeletedWebhook = z.infer<typeof PostDeletedWebhookSchema>;

/** The remote-post sweep found the source record deleted and removed Antiphony's copy. */
export const RemoteGoneWebhookSchema = z.object({
    type: z.literal('remote.gone'),
    uri: PostUriSchema,
    ...base,
});
export type RemoteGoneWebhook = z.infer<typeof RemoteGoneWebhookSchema>;

/**
 * The sweep found the source record edited. `cid` is its new CID; the sweep
 * always sets it today, but the sender's type allows its absence, so it is
 * optional here rather than promised.
 */
export const RemoteChangedWebhookSchema = z.object({
    type: z.literal('remote.changed'),
    uri: PostUriSchema,
    cid: z.string().min(1).optional(),
    ...base,
});
export type RemoteChangedWebhook = z.infer<typeof RemoteChangedWebhookSchema>;

/**
 * Records registered in a space are due for a recheck, which takes a fresh
 * delegation. Both `uri` and `space` are the SPACE's URI (not a record's). The
 * tenant answers with `POST /api/v1/remote-posts/recheck`. As with `cid`, the
 * sweep always sets `space`; the sender's type only allows its absence.
 */
export const RemoteRecheckRequestedWebhookSchema = z.object({
    type: z.literal('remote.recheck_requested'),
    uri: RemoteSpaceUriSchema,
    space: RemoteSpaceUriSchema.optional(),
    ...base,
});
export type RemoteRecheckRequestedWebhook = z.infer<typeof RemoteRecheckRequestedWebhookSchema>;

/**
 * Any webhook body, discriminated on `type`.
 *
 * **Ignore an unknown `type`; do not fail on it.** New event types are
 * additive, so a receiver built today will one day be sent a type it has never
 * heard of. This schema rejects such a body (it matches no member), so check
 * `type` against `WEBHOOK_EVENT_TYPES` first, acknowledge with a 2xx and move
 * on. Answering 4xx instead would be logged by the sender as a rejection, and a
 * 5xx would be retried, for an event you will never handle.
 */
export const WebhookEventSchema = z.discriminatedUnion('type', [
    StageSettledWebhookSchema,
    PostDeletedWebhookSchema,
    RemoteGoneWebhookSchema,
    RemoteChangedWebhookSchema,
    RemoteRecheckRequestedWebhookSchema,
]);
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/** The `type` values this release of the schemas knows, for telling an unknown type from a malformed body. */
export const WEBHOOK_EVENT_TYPES = WebhookEventSchema.options.map((o) => o.shape.type.value);
export type WebhookEventType = WebhookEvent['type'];
