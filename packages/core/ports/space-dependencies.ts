import type { SpaceKey, SpacePolicy, SpaceRecord } from 'shared/types/spaces';

/**
 * Persistence for atproto spaces (specs/spaces.md). Every call is scoped to one
 * tenant: a space's authority is that tenant's own DID, so `(originAppId, type,
 * skey)` is the whole key.
 */
export interface SpaceDependencies {
    /** The tenant's app DID: the authority of every space it owns. */
    getAppDid(originAppId: string): string;

    getSpace(originAppId: string, key: SpaceKey): Promise<SpaceRecord | null>;

    /**
     * Create the space, or replace its policies if it exists. Returns the stored
     * space, with `createdAt` unchanged on a replace.
     */
    putSpace(input: {
        originAppId: string;
        key: SpaceKey;
        readPolicy: SpacePolicy;
        writePolicy: SpacePolicy;
        managingAppEndpoint?: string;
    }): Promise<SpaceRecord>;
}
