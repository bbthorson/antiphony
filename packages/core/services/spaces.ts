import { isValidNsid, isValidRecordKey, SpaceRef } from '@atproto/syntax';
import { NotFoundError, ValidationError } from 'shared/errors';
import type { SpaceKey, SpacePolicy, SpaceRecord, SpaceView } from 'shared/types/spaces';
import type { SpaceDependencies } from '../ports/space-dependencies';

/**
 * SpaceService — a tenant's atproto spaces (specs/spaces.md, Phase 2).
 *
 * A space is `(authority DID, type, skey)`; the authority is always the calling
 * tenant's DID, so a tenant only ever names `{ type, skey }`. Policies are
 * replaced, not merged, so the same PUT always leaves the same space.
 *
 * Enforcement doesn't live here: posts check their space through
 * `AudioPostDependencies.getSpace`, and playback of a spaced post's audio is
 * signed (apps/core-api lib/playback-signature.ts).
 */
export class SpaceService {
    constructor(private readonly deps: SpaceDependencies) {}

    async putSpace(input: {
        originAppId: string;
        key: SpaceKey;
        readPolicy: SpacePolicy;
        writePolicy: SpacePolicy;
        managingAppEndpoint?: string;
    }): Promise<SpaceView> {
        assertValidSpaceKey(input.key);
        const stored = await this.deps.putSpace(input);
        return this.toView(stored);
    }

    async getSpace(originAppId: string, key: SpaceKey): Promise<SpaceView> {
        assertValidSpaceKey(key);
        const stored = await this.deps.getSpace(originAppId, key);
        if (!stored) throw new NotFoundError('Space not found');
        return this.toView(stored);
    }

    toView(space: SpaceRecord): SpaceView {
        return {
            uri: spaceUri(this.deps.getAppDid(space.originAppId), space),
            type: space.type,
            skey: space.skey,
            readPolicy: space.readPolicy,
            writePolicy: space.writePolicy,
            ...(space.managingAppEndpoint ? { managingAppEndpoint: space.managingAppEndpoint } : {}),
            createdAt: space.createdAt.toISOString(),
            updatedAt: space.updatedAt.toISOString(),
        };
    }
}

/** Reject a space key whose parts aren't atproto syntax (an NSID type, a record-key skey). */
export function assertValidSpaceKey(key: SpaceKey): void {
    if (!isValidNsid(key.type)) throw new ValidationError(`Invalid space type (must be an NSID): ${key.type}`);
    if (!isValidRecordKey(key.skey)) throw new ValidationError(`Invalid space key (must be a record key): ${key.skey}`);
}

/** A space's own `at://` reference: `at://{authority}/space/{type}/{skey}`. */
export function spaceUri(authority: string, key: SpaceKey): string {
    // Validated by the caller; SpaceRef wants the branded string types.
    return new SpaceRef(authority as `did:${string}:${string}`, key.type as `${string}.${string}.${string}`, key.skey).toString();
}
