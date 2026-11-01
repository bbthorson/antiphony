import type { ScopedSpaceKey, SpacePolicy, SpaceRecord } from 'shared/types/spaces';

/**
 * Persistence for atproto spaces (specs/spaces.md). Every call is scoped to one
 * tenant. A space's authority is the tenant's app DID, or a DID the tenant
 * registered (specs/did-plc-and-multi-did-tenancy.md §3), so the key is
 * `(originAppId, authority, type, skey)`; an absent `authority` is the app DID.
 */
export interface SpaceDependencies {
    /** The tenant's app DID: the authority of a space that names no other. */
    getAppDid(originAppId: string): string;

    /** As `AudioPostDependencies.assertWritableAuthority`: creating a space under `did` needs the same proof. */
    assertWritableAuthority(originAppId: string, did: string): Promise<void>;

    getSpace(originAppId: string, key: ScopedSpaceKey): Promise<SpaceRecord | null>;

    /**
     * Create the space, or replace its policies if it exists. Returns the stored
     * space, with `createdAt` unchanged on a replace.
     */
    putSpace(input: {
        originAppId: string;
        key: ScopedSpaceKey;
        readPolicy: SpacePolicy;
        writePolicy: SpacePolicy;
        managingAppEndpoint?: string;
    }): Promise<SpaceRecord>;

    /**
     * Delete the space if no post is in it. `absent` when there was no such
     * space; `not-empty` when posts remain, because a post's space is sealed into
     * its URI and every reply's StrongRef, so a space holding posts can't go.
     */
    deleteSpace(originAppId: string, key: ScopedSpaceKey): Promise<'deleted' | 'absent' | 'not-empty'>;
}
