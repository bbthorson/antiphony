import { SpaceRecordSchema, type ScopedSpaceKey, type SpaceRecord } from 'shared/types/spaces';
import type { SpaceDependencies } from '@antiphony/core/ports/space-dependencies';
import type { SqlClient } from '../../../ports/sql-client.js';
import { getAppDid as resolveAppDid } from '../../../lib/app-did.js';
import { writableAuthorityCheck } from './writable-authority.js';

/**
 * Postgres `SpaceDependencies` over the `spaces` table (migrations/0002_spaces.sql,
 * 0005_authority.sql). Every statement is scoped by `origin_app_id`, so a tenant
 * can only ever see or replace its own; within it, a space is keyed by its
 * authority too ('' for the app DID).
 */

interface SpaceRow {
    origin_app_id: string;
    authority: string;
    space_type: string;
    skey: string;
    read_policy: string;
    write_policy: string;
    managing_app_endpoint: string | null;
    created_at: string | Date;
    updated_at: string | Date;
}

const COLS =
    'origin_app_id, authority, space_type, skey, read_policy, write_policy, managing_app_endpoint, created_at, updated_at';

/** The column's spelling of a key's authority: '' for the app DID (migrations/0005_authority.sql). */
const authorityCol = (key: ScopedSpaceKey) => key.authority ?? '';

function toRecord(row: SpaceRow): SpaceRecord {
    return SpaceRecordSchema.parse({
        originAppId: row.origin_app_id,
        ...(row.authority !== '' ? { authority: row.authority } : {}),
        type: row.space_type,
        skey: row.skey,
        readPolicy: row.read_policy,
        writePolicy: row.write_policy,
        ...(row.managing_app_endpoint ? { managingAppEndpoint: row.managing_app_endpoint } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

/**
 * Postgres `SpaceDependencies`. `assertWritableAuthority` is shared with the
 * posts binding, which passes the same function in; it is the registry check
 * plus custody re-proven per DID (`writable-authority.ts`).
 */
export function postgresSpaceDependencies(
    sql: SqlClient,
    assertWritableAuthority: SpaceDependencies['assertWritableAuthority'] = writableAuthorityCheck(sql),
): SpaceDependencies {
    return {
        getAppDid(originAppId: string): string {
            return resolveAppDid(originAppId);
        },

        assertWritableAuthority,

        async getSpace(originAppId, key) {
            const [row] = await sql.query<SpaceRow>(
                `select ${COLS} from spaces
                  where origin_app_id = $1 and authority = $2 and space_type = $3 and skey = $4`,
                [originAppId, authorityCol(key), key.type, key.skey],
            );
            return row ? toRecord(row) : null;
        },

        async putSpace(input) {
            // One upsert: a replace keeps `created_at` and moves `updated_at`.
            const [row] = await sql.query<SpaceRow>(
                `
                insert into spaces (origin_app_id, authority, space_type, skey, read_policy, write_policy, managing_app_endpoint)
                values ($1, $2, $3, $4, $5, $6, $7)
                on conflict (origin_app_id, authority, space_type, skey) do update
                    set read_policy           = excluded.read_policy,
                        write_policy          = excluded.write_policy,
                        managing_app_endpoint = excluded.managing_app_endpoint,
                        updated_at            = now()
                returning ${COLS}
                `,
                [
                    input.originAppId,
                    authorityCol(input.key),
                    input.key.type,
                    input.key.skey,
                    input.readPolicy,
                    input.writePolicy,
                    input.managingAppEndpoint ?? null,
                ],
            );
            if (!row) throw new Error('[postgres] space upsert returned no row');
            return toRecord(row);
        },

        async deleteSpace(originAppId, key) {
            // One statement. The `not exists` guard answers "not empty" itself
            // rather than leaning on the posts foreign key, which would refuse
            // the delete with an error indistinguishable from any other failure.
            const [row] = await sql.query<{ found: boolean; deleted: boolean }>(
                `
                with target as (
                    select 1 from spaces
                     where origin_app_id = $1 and authority = $2 and space_type = $3 and skey = $4
                ), removed as (
                    delete from spaces
                     where origin_app_id = $1 and authority = $2 and space_type = $3 and skey = $4
                       and not exists (
                           select 1 from posts
                            where origin_app_id = $1 and space_authority = $2 and space_type = $3 and skey = $4
                       )
                    returning 1
                )
                select exists (select 1 from target) as found, exists (select 1 from removed) as deleted
                `,
                [originAppId, authorityCol(key), key.type, key.skey],
            );
            if (!row?.found) return 'absent';
            return row.deleted ? 'deleted' : 'not-empty';
        },
    };
}
