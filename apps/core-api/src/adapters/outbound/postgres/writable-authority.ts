import { authorityCustodyUnproven, authorityNotRegistered } from '@antiphony/core/services/did-registry';
import type { AudioPostDependencies } from '@antiphony/core/ports/audio-posts-dependencies';
import type { SqlClient } from '../../../ports/sql-client.js';
import { APP_CONFIG } from '../../../lib/app-config.js';
import { ensureDidCustody, type EnsurePinOptions } from '../../../lib/app-did.js';
import { logger } from '../../../lib/logger.js';

/**
 * `assertWritableAuthority` for the Postgres bindings: may this tenant write
 * under `did`, a DID other than its app DID?
 *
 *  1. **Registered to this tenant** (`tenant_dids`, migration 0004). One indexed
 *     read; another tenant's DID reads the same as an unregistered one. (The
 *     foreign keys in migration 0005 refuse such a write too, but with an error
 *     no caller could tell from any other.)
 *  2. **Custody still proven**: the DID's document names this deployment as its
 *     space host, through the same cached, outage-tolerant check the app DID
 *     gets (`ensureDidCustody`). Registration proved it once; this is what keeps
 *     a group that moved its space host from still being written under here.
 */
export function writableAuthorityCheck(
    sql: SqlClient,
    custody: EnsurePinOptions = { expectedPdsHost: APP_CONFIG.PDS_HOST },
): AudioPostDependencies['assertWritableAuthority'] {
    return async (originAppId, did) => {
        const rows = await sql.query<{ did: string }>(
            'select did from tenant_dids where did = $1 and origin_app_id = $2',
            [did, originAppId],
        );
        if (rows.length === 0) throw authorityNotRegistered(did);
        try {
            await ensureDidCustody(did, custody);
        } catch (err) {
            logger.error({ err, originAppId, did }, '[authority] custody unproven for a registered DID; refusing the write');
            throw authorityCustodyUnproven(did);
        }
    };
}
