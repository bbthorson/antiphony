import { TenantDidRecordSchema, type TenantDidRecord } from 'shared/types/dids';
import type { CustodyProof, DidRegistryDependencies } from '@antiphony/core/ports/did-registry-dependencies';
import type { SqlClient } from '../../../ports/sql-client.js';
import { getAppDid as resolveAppDid, parseAppDids, validateAppDid, type ValidateAppDidOptions } from '../../../lib/app-did.js';

/**
 * Postgres `DidRegistryDependencies` over `tenant_dids`
 * (migrations/0004_tenant_dids.sql), with custody proven by the same validator
 * the app DID passes (`validateAppDid`): the document must name this deployment
 * as its space host. Unlike the app DID, an expected host is required.
 */

interface TenantDidRow {
    did: string;
    origin_app_id: string;
    role: string;
    subject_ref: string | null;
    created_at: string | Date;
}

const COLS = 'did, origin_app_id, role, subject_ref, created_at';

function toRecord(row: TenantDidRow): TenantDidRecord {
    return TenantDidRecordSchema.parse({
        did: row.did,
        originAppId: row.origin_app_id,
        role: row.role,
        ...(row.subject_ref !== null ? { subjectRef: row.subject_ref } : {}),
        createdAt: row.created_at,
    });
}

export function postgresDidRegistryDependencies(
    sql: SqlClient,
    custody: Pick<ValidateAppDidOptions, 'expectedPdsHost' | 'plcDirectoryUrl' | 'fetchImpl'> = {},
): DidRegistryDependencies {
    return {
        getAppDid(originAppId) {
            return resolveAppDid(originAppId);
        },

        isPinnedAppDid(did) {
            for (const pinned of parseAppDids().values()) if (pinned === did) return true;
            return false;
        },

        async proveCustody(did): Promise<CustodyProof> {
            // Without an expected host, `validateAppDid` accepts any space host
            // at all. That's an operator's choice for the app DID; for a DID a
            // tenant asks us to accept, it would let the tenant claim anyone's.
            if (!custody.expectedPdsHost) {
                return { ok: false, kind: 'unconfigured', reason: 'no ANTIPHONY_PDS_HOST' };
            }
            const result = await validateAppDid(did, custody);
            return result.ok ? { ok: true } : { ok: false, kind: result.kind, reason: result.reason };
        },

        async getTenantDid(did) {
            const [row] = await sql.query<TenantDidRow>(`select ${COLS} from tenant_dids where did = $1`, [did]);
            return row ? toRecord(row) : null;
        },

        async insertTenantDid(input) {
            // `on conflict do nothing`: the primary key is what keeps a DID to one
            // tenant, and the service reads the row back to judge a conflict.
            const rows = await sql.query<{ did: string }>(
                `
                insert into tenant_dids (did, origin_app_id, role, subject_ref)
                values ($1, $2, $3, $4)
                on conflict (did) do nothing
                returning did
                `,
                [input.did, input.originAppId, input.role, input.subjectRef ?? null],
            );
            return rows.length > 0 ? 'inserted' : 'exists';
        },

        async deleteTenantDid(originAppId, did) {
            // One statement, shaped like deleteSpace: the `not exists` guards
            // answer "in use" themselves rather than leaning on the foreign keys
            // from posts and spaces (migration 0005), whose refusal would be
            // indistinguishable from any other failure.
            const [row] = await sql.query<{ found: boolean; deleted: boolean }>(
                `
                with target as (
                    select 1 from tenant_dids where did = $1 and origin_app_id = $2
                ), removed as (
                    delete from tenant_dids
                     where did = $1 and origin_app_id = $2
                       and not exists (select 1 from posts  where authority = $1     and origin_app_id = $2)
                       and not exists (select 1 from spaces where authority_did = $1 and origin_app_id = $2)
                    returning 1
                )
                select exists (select 1 from target) as found, exists (select 1 from removed) as deleted
                `,
                [did, originAppId],
            );
            if (!row?.found) return 'absent';
            return row.deleted ? 'deleted' : 'in-use';
        },

        async listTenantDids(originAppId, { limit, cursor }) {
            // Newest first, keyed on (created_at, did). The cursor is the last
            // DID of the previous page, resolved in the same statement; a cursor
            // naming a row that isn't this tenant's starts from the top, as the
            // posts listing does.
            const rows = await sql.query<TenantDidRow>(
                `
                with cursor as (
                    select created_at, did from tenant_dids
                    where did = $2 and origin_app_id = $1
                )
                select ${COLS} from tenant_dids
                where origin_app_id = $1
                  and ($2::text is null
                       or not exists (select 1 from cursor)
                       or (created_at, did) < (select created_at, did from cursor))
                order by created_at desc, did desc
                limit $3
                `,
                [originAppId, cursor ?? null, limit + 1],
            );
            const items = rows.slice(0, limit).map(toRecord);
            return { items, nextCursor: rows.length > limit ? (items.at(-1)?.did ?? null) : null };
        },
    };
}
