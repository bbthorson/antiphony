import { getAdminDb } from '../../../lib/firebase-admin.js';
import { logger } from '../../../lib/logger.js';
import {
    ConnectorConfigRecordSchema,
    type ConnectorConfigRecord,
    type ConnectorType,
} from 'shared/types/records';
import type { ConnectorConfigDependencies } from '@vox-pop/core/ports/connector-config-dependencies';

export type { ConnectorConfigDependencies };

/**
 * Firebase-wired `ConnectorConfigDependencies` binding for core-api (Plan B).
 *
 * Storage path: `connector_configs/{ownerId}/items/{connectorType}` — one doc
 * per (owner, connectorType). Pure envelope CRUD; core never interprets the
 * opaque `settings` blob and never stores raw secrets.
 *
 * See `specs/plan-b-connector-boundaries.md`.
 */

function configRef(ownerId: string, connectorType: ConnectorType) {
    return getAdminDb()
        .collection('connector_configs')
        .doc(ownerId)
        .collection('items')
        .doc(connectorType);
}

export const firebaseConnectorConfigDependencies: ConnectorConfigDependencies = {
    async getConfig(ownerId: string, connectorType: ConnectorType): Promise<ConnectorConfigRecord | null> {
        if (!ownerId || !ownerId.trim()) return null;
        const snap = await configRef(ownerId, connectorType).get();
        if (!snap.exists) return null;

        // Runtime-validate the stored doc. Surfaces schema drift at the API
        // boundary instead of leaking malformed data to callers; a partial /
        // migrating doc reads as "no config" rather than throwing. Log the
        // failure — otherwise a present-but-invalid doc silently 404s, which is
        // hard to distinguish from "no config" when debugging schema drift.
        const parsed = ConnectorConfigRecordSchema.safeParse(snap.data());
        if (!parsed.success) {
            logger.error(
                { err: parsed.error, ownerId, connectorType },
                'Connector config failed schema validation (drift or corruption) — returning null',
            );
            return null;
        }
        return parsed.data;
    },

    async saveConfig(record: ConnectorConfigRecord): Promise<void> {
        await configRef(record.ownerId, record.connectorType).set(record);
    },

    async updateConfig(
        ownerId: string,
        connectorType: ConnectorType,
        updates: Partial<ConnectorConfigRecord>,
    ): Promise<void> {
        // Firestore `update()` requires at least one field; the service
        // guarantees a non-empty update, but stay robust to future refactors.
        if (Object.keys(updates).length === 0) return;
        await configRef(ownerId, connectorType).update(updates);
    },

    async deleteConfig(ownerId: string, connectorType: ConnectorType): Promise<void> {
        await configRef(ownerId, connectorType).delete();
    },

    now(): Date {
        return new Date();
    },
};
