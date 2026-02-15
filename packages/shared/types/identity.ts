/**
 * Identity Resolver Interface
 *
 * Abstracts identity operations so the service layer doesn't depend
 * on a specific identity provider (Firebase Auth, AT Protocol PDS, etc.).
 *
 * Current implementation: FirebaseIdentityResolver (see below)
 * Future: ATProtocolIdentityResolver (resolves via PDS/PLC directory)
 */

import type { ProfileViewBasic } from './views';

export interface IdentityResolver {
    /** Resolve a handle (e.g. "alice") to a user ID / DID */
    resolveHandle(handle: string): Promise<string | null>;

    /** Resolve a user ID / DID to a basic profile */
    resolveId(id: string): Promise<ProfileViewBasic | null>;

    /** Verify that a handle belongs to a given user ID */
    verifyHandleOwnership(handle: string, id: string): Promise<boolean>;
}
