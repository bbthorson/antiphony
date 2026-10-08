import { SpaceRecordSchema, type SpaceRecord } from 'shared/types/spaces';
import type { SpaceDependencies } from '@antiphony/core/ports/space-dependencies';
import type { SqlClient } from '../../../ports/sql-client.js';
import { getAppDid as resolveAppDid } from '../../../lib/app-did.js';

/**
 * Postgres `SpaceDependencies` over the `spaces` table (migrations/0002_spaces.sql).
 * Every statement is scoped by `origin_app_id`: a space's authority is its
 * tenant's DID, so a tenant can only ever see or replace its own.
 */

interface SpaceRow {
    origin_app_id: string;
    space_type: string;
    skey: string;
    read_policy: string;
    write_policy: string;
    managing_app_endpoint: string | null;
    created_at: string | Date;
    updated_at: string | Date;
}

const COLS = 'origin_app_id, space_type, skey, read_policy, write_policy, managing_app_endpoint, created_at, updated_at';

function toRecord(row: SpaceRow): SpaceRecord {
    return SpaceRecordSchema.parse({
        originAppId: row.origin_app_id,
        type: row.space_type,
        skey: row.skey,
        readPolicy: row.read_policy,
        writePolicy: row.write_policy,
        ...(row.managing_app_endpoint ? { managingAppEndpoint: row.managing_app_endpoint } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

export function postgresSpaceDependencies(sql: SqlClient): SpaceDependencies {
    return {
        getAppDid(originAppId: string): string {
            return resolveAppDid(originAppId);
        },

        async getSpace(originAppId, key) {
            const [row] = await sql.query<SpaceRow>(
                `select ${COLS} from spaces where origin_app_id = $1 and space_type = $2 and skey = $3`,
                [originAppId, key.type, key.skey],
            );
            return row ? toRecord(row) : null;
        },

        async putSpace(input) {
            // One upsert: a replace keeps `created_at` and moves `updated_at`.
            const [row] = await sql.query<SpaceRow>(
                `
                insert into spaces (origin_app_id, space_type, skey, read_policy, write_policy, managing_app_endpoint)
                values ($1, $2, $3, $4, $5, $6)
                on conflict (origin_app_id, space_type, skey) do update
                    set read_policy           = excluded.read_policy,
                        write_policy          = excluded.write_policy,
                        managing_app_endpoint = excluded.managing_app_endpoint,
                        updated_at            = now()
                returning ${COLS}
                `,
                [
                    input.originAppId,
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
    };
}
