import { z } from 'zod';
import { FirestoreTimestampSchema } from './records';

/**
 * Optional AT Protocol DID mapping for an actor (B4-prep — additive, not
 * part of the legacy `UserRecordSchema`/`users` collection).
 *
 * Antiphony holds the DID↔actor mapping **when a connecting app wants it
 * held here**: the app runs its own OAuth ceremony (that flow is product
 * UX, tied to the app's origin — it stays in the app), then registers the
 * verified result via `POST /api/v1/actors/register` using the
 * service-auth acting-actor-DID assertion (`specs/service-auth.md`).
 * Antiphony trusts the assertion within the asserting app's own tenancy —
 * it cannot independently verify a DID belongs to a given actor.
 *
 * Why here at all, if the app already knows it: the mapping travels WITH
 * the records Antiphony stores (`authorDid` on posts, `at://` URIs,
 * StrongRefs). A caller-only mapping would let the same actor's DID drift
 * or go missing across requests; storing it once means every post by that
 * actor stamps `authorDid` consistently, including a later backfill if the
 * actor links their identity after posting for a while.
 *
 * `did` is canonical; `handle` is a display-only snapshot (Bluesky handles
 * change; DIDs don't) refreshed opportunistically on each app assertion.
 */
export const ActorIdentityRecordSchema = z.object({
    /** The actor id, scoped to `originAppId` — the same id apps pass as
     *  authorId / X-Antiphony-Acting-Actor. */
    id: z.string(),
    /** Tenancy key — the app that registered this identity. */
    originAppId: z.string(),
    /** AT Protocol DID, asserted by the app. Canonical; never inferred. */
    did: z.string().optional(),
    /** Display-only handle snapshot at last assertion. Not a join key. */
    handle: z.string().optional(),
    updatedAt: FirestoreTimestampSchema,
});
export type ActorIdentityRecord = z.infer<typeof ActorIdentityRecordSchema>;

/** Public projection returned by the actors surface — no storage fields beyond id/did/handle. */
export const ActorIdentityViewSchema = z.object({
    id: z.string(),
    did: z.string().optional(),
    handle: z.string().optional(),
});
export type ActorIdentityView = z.infer<typeof ActorIdentityViewSchema>;
