import type { ActorIdentityRecord } from 'shared/types/actor-identity';
import { ValidationError } from 'shared/errors';
import type { ActorIdentityDependencies } from '../ports/actor-identity-dependencies';

/** Loose DID syntax check (`did:<method>:<method-specific-id>`) — full method-specific validation is the identity provider's job, not ours. */
const DID_PATTERN = /^did:[a-z0-9]+:.+$/;

export class ActorIdentityService {
    constructor(private readonly deps: ActorIdentityDependencies) {}

    /**
     * Register (upsert) an actor's DID/handle, asserted by an authenticated
     * app on the actor's behalf (`specs/service-auth.md`). At least one of
     * `did`/`handle` must be present — a no-op assertion is a caller bug.
     */
    async registerIdentity(
        originAppId: string,
        actorId: string,
        fields: { did?: string; handle?: string },
    ): Promise<ActorIdentityRecord> {
        if (!fields.did && !fields.handle) {
            throw new ValidationError('At least one of did/handle is required');
        }
        if (fields.did && !DID_PATTERN.test(fields.did)) {
            throw new ValidationError('did must be a valid AT Protocol DID (did:<method>:<id>)');
        }
        return this.deps.upsertIdentity(originAppId, actorId, fields);
    }

    async getIdentity(originAppId: string, actorId: string): Promise<ActorIdentityRecord | null> {
        return this.deps.getIdentity(originAppId, actorId);
    }
}
