import type { TenantDidRecord, TenantDidRole } from 'shared/types/dids';

/**
 * The outcome of resolving a DID document and checking it names this deployment
 * as its space host: the same custody contract the tenant's app DID passes
 * (apps/core-api lib/app-did.ts, `validateAppDid`).
 *
 *  - `disproof`: the document was read and does not make the claim. Final.
 *  - `unreachable`: no answer (DID host or PLC directory down). Retryable.
 *  - `unconfigured`: this deployment doesn't know its own host
 *    (`ANTIPHONY_PDS_HOST`), so "names this deployment" can't be checked. Without
 *    it any DID naming any space host would pass, so nothing is registered.
 */
export type CustodyProof =
    | { ok: true }
    | { ok: false; kind: 'disproof' | 'unreachable' | 'unconfigured'; reason: string };

/** One page of a tenant's registered DIDs, newest first. */
export interface TenantDidPage {
    items: TenantDidRecord[];
    nextCursor: string | null;
}

/**
 * Persistence and checks for the DIDs a tenant may write under besides its app
 * DID (specs/did-plc-and-multi-did-tenancy.md §3).
 */
export interface DidRegistryDependencies {
    /** The calling tenant's own app DID, which is never registered here. */
    getAppDid(originAppId: string): string;
    /** True when `did` is some tenant's pinned app DID (ANTIPHONY_APP_DIDS). */
    isPinnedAppDid(did: string): boolean;
    /** Resolve the DID document and check it names this deployment. Network I/O. */
    proveCustody(did: string): Promise<CustodyProof>;

    /** The registration for `did`, whichever tenant holds it. */
    getTenantDid(did: string): Promise<TenantDidRecord | null>;
    /**
     * Insert the registration unless `did` is already registered (to anyone).
     * `exists` means nothing was written; read it back to see whose it is.
     */
    insertTenantDid(input: {
        did: string;
        originAppId: string;
        role: TenantDidRole;
        subjectRef?: string;
    }): Promise<'inserted' | 'exists'>;
    /**
     * Delete this tenant's registration of `did`, unless any post or space is
     * still under it: their URIs name the DID, so it can't stop being one this
     * tenant writes under while they exist. `absent` when this tenant hasn't
     * registered it (including when another tenant has).
     */
    deleteTenantDid(originAppId: string, did: string): Promise<'deleted' | 'absent' | 'in-use'>;
    /** A tenant's registrations, newest first. `cursor` is opaque, from a previous page. */
    listTenantDids(originAppId: string, opts: { limit: number; cursor?: string }): Promise<TenantDidPage>;
}
