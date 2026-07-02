import type { ActorIdentityRecord } from 'shared/types/actor-identity';

/**
 * ActorIdentityDependencies is the portable interface `ActorIdentityService`
 * uses to persist the optional actor↔DID mapping (B4-prep; see
 * `shared/types/actor-identity.ts` for why this exists and what it isn't).
 *
 * Deliberately its OWN small store — not the legacy `UserRecordSchema`/
 * `users` collection, which is Vox Pop's profile surface and is slated for
 * removal once the BFF owns it (see specs/service-auth.md and the B3/B4
 * migration plan). Keeping this additive and separate means it needs no
 * coordination with that removal.
 */
export interface ActorIdentityDependencies {
    /**
     * Upsert the DID/handle for an actor within an origin app. Merges: a
     * field omitted from `fields` leaves the stored value untouched (an app
     * re-asserting just a refreshed handle doesn't clear a previously
     * registered DID).
     */
    upsertIdentity(
        originAppId: string,
        actorId: string,
        fields: { did?: string; handle?: string },
    ): Promise<ActorIdentityRecord>;

    /** Fetch an actor's identity, scoped to `originAppId`. Null if never registered or cross-tenant. */
    getIdentity(originAppId: string, actorId: string): Promise<ActorIdentityRecord | null>;

    /** Current server time as a `Date`. */
    now(): Date;
}
