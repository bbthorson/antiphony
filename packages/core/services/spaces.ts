import { isValidDid, isValidNsid, isValidRecordKey, SpaceRef } from '@atproto/syntax';
import { NotFoundError, ServiceError, ValidationError } from 'shared/errors';
import type { ScopedSpaceKey, SpaceKey, SpacePolicy, SpaceRecord, SpaceView } from 'shared/types/spaces';
import type { SpaceDependencies } from '../ports/space-dependencies';

/**
 * SpaceService — a tenant's atproto spaces (specs/spaces.md, Phase 2).
 *
 * A space is `(authority DID, type, skey)`. The authority is the calling
 * tenant's app DID unless the key names a DID the tenant registered
 * (specs/did-plc-and-multi-did-tenancy.md §3); naming the app DID is the same as
 * naming none. Policies are replaced, not merged, so the same PUT always leaves
 * the same space.
 *
 * Enforcement doesn't live here: posts check their space through
 * `AudioPostDependencies.getSpace`, and playback of a spaced post's audio is
 * signed (apps/core-api lib/playback-signature.ts).
 */
export class SpaceService {
    constructor(private readonly deps: SpaceDependencies) {}

    async putSpace(input: {
        originAppId: string;
        key: ScopedSpaceKey;
        readPolicy: SpacePolicy;
        writePolicy: SpacePolicy;
        managingAppEndpoint?: string;
    }): Promise<SpaceView> {
        const key = this.scoped(input.originAppId, input.key);
        // Creating a space under another DID needs the same proof as a post under it.
        if (key.authority !== undefined) await this.deps.assertWritableAuthority(input.originAppId, key.authority);
        const stored = await this.deps.putSpace({ ...input, key });
        return this.toView(stored);
    }

    async getSpace(originAppId: string, key: ScopedSpaceKey): Promise<SpaceView> {
        const stored = await this.deps.getSpace(originAppId, this.scoped(originAppId, key));
        if (!stored) throw new NotFoundError('Space not found');
        return this.toView(stored);
    }

    /**
     * Delete an empty space (specs/deletion.md § 4.3). True when it was deleted,
     * false when there was no such space, so a retry is harmless. A space that
     * still holds posts is a 409 `SPACE_NOT_EMPTY`.
     */
    async deleteSpace(originAppId: string, key: ScopedSpaceKey): Promise<boolean> {
        const outcome = await this.deps.deleteSpace(originAppId, this.scoped(originAppId, key));
        if (outcome === 'not-empty') throw new SpaceNotEmptyError();
        return outcome === 'deleted';
    }

    private scoped(originAppId: string, key: ScopedSpaceKey): ScopedSpaceKey {
        return scopedKey(key, this.deps.getAppDid(originAppId));
    }

    toView(space: SpaceRecord): SpaceView {
        const authority = space.authority ?? this.deps.getAppDid(space.originAppId);
        return {
            uri: spaceUri(authority, space),
            authority,
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

/**
 * Validate a key and normalise its authority: the tenant's app DID, named or
 * not, is stored as no authority, so one space can't exist twice under two
 * spellings of the same owner.
 */
function scopedKey(key: ScopedSpaceKey, appDid: string): ScopedSpaceKey {
    assertValidSpaceKey(key);
    if (key.authority === undefined || key.authority === appDid) return { type: key.type, skey: key.skey };
    if (!isValidDid(key.authority)) throw new ValidationError(`Invalid space authority (must be a DID): ${key.authority}`);
    return { type: key.type, skey: key.skey, authority: key.authority };
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

/** 409 — a space can't be deleted while any post is in it. */
export const SPACE_NOT_EMPTY = 'SPACE_NOT_EMPTY';

export class SpaceNotEmptyError extends ServiceError {
    constructor() {
        super('Space still holds posts; delete them first', 409, undefined, SPACE_NOT_EMPTY);
        this.name = 'SpaceNotEmptyError';
    }
}
