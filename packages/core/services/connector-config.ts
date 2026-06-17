import {
    ConnectorConfigRecordSchema,
    type ConnectorConfigRecord,
    type ConnectorStatus,
    type ConnectorType,
} from 'shared/types/records';
import { NotFoundError } from 'shared/errors';
import type { ConnectorConfigDependencies } from '../ports/connector-config-dependencies';

/**
 * Input shape for create/replace — the wire fields a caller controls. The
 * service owns `connectorType` (route path), `ownerId` (auth), the
 * `createdAt`/`updatedAt` stamps, and `status` (connector-reported, set only via
 * `reportStatus` — never by an end-user write), so all are excluded here.
 */
export type ConnectorConfigInput = Omit<
    ConnectorConfigRecord,
    'connectorType' | 'ownerId' | 'status' | 'createdAt' | 'updatedAt'
>;

/**
 * ConnectorConfigService — the uniform control plane for connector settings
 * (Plan B). Pure envelope CRUD over `ConnectorConfigRecord`; the core never
 * interprets `settings` (opaque, connector-validated) and never stores raw
 * secrets (only `secretRef`).
 *
 * Telephony is the first connector to use this (see
 * `specs/plan-b-connector-boundaries.md`); the contract is intentionally
 * connector-agnostic so future ingress/egress connectors and the web settings
 * page (the control-plane UI) drive every connector through one shape.
 */
export class ConnectorConfigService {
    constructor(private readonly deps: ConnectorConfigDependencies) {}

    /** Read an owner's config for a connector. Returns null if none exists. */
    async getConfig(ownerId: string, connectorType: ConnectorType): Promise<ConnectorConfigRecord | null> {
        return this.deps.getConfig(ownerId, connectorType);
    }

    /**
     * Create (or replace) an owner's config. Stamps `createdAt`/`updatedAt`
     * fresh and re-validates the full envelope at the service boundary.
     */
    async saveConfig(
        ownerId: string,
        connectorType: ConnectorType,
        input: ConnectorConfigInput,
    ): Promise<ConnectorConfigRecord> {
        const now = this.deps.now();
        // Read existing so a user-facing config write preserves the
        // system-owned fields: `status` (connector-reported — never set here;
        // see reportStatus) and the original `createdAt`. Default both on first
        // create.
        const existing = await this.deps.getConfig(ownerId, connectorType);
        const record: ConnectorConfigRecord = {
            ...input,
            connectorType,
            ownerId,
            status: existing?.status ?? { state: 'unconfigured' },
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        const validated = ConnectorConfigRecordSchema.parse(record);
        await this.deps.saveConfig(validated);
        return validated;
    }

    /**
     * Apply a partial update. Stamps `updatedAt`. Throws `NotFoundError` if no
     * config exists (the core-api error handler maps it to 404).
     */
    async updateConfig(
        ownerId: string,
        connectorType: ConnectorType,
        updates: Partial<ConnectorConfigInput>,
    ): Promise<ConnectorConfigRecord> {
        const existing = await this.deps.getConfig(ownerId, connectorType);
        if (!existing) {
            throw new NotFoundError(`No ${connectorType} connector config for this owner`);
        }
        const now = this.deps.now();
        // Merge `settings` rather than replace it. Firestore overwrites a
        // top-level map field wholesale on update, so a partial PATCH like
        // `{ settings: { tier: 'pro' } }` would otherwise drop every other
        // settings key (phoneNumber, …). Shallow-merge preserves the rest.
        const settings = updates.settings
            ? { ...existing.settings, ...updates.settings }
            : existing.settings;
        const merged: ConnectorConfigRecord = {
            ...existing,
            ...updates,
            settings,
            updatedAt: now,
        };
        const validated = ConnectorConfigRecordSchema.parse(merged);
        await this.deps.updateConfig(ownerId, connectorType, { ...updates, settings, updatedAt: now });
        return validated;
    }

    /**
     * Enable or disable a connector. Convenience over `updateConfig` — flips
     * the `enabled` flag. Throws `NotFoundError` if no config exists.
     */
    async setEnabled(
        ownerId: string,
        connectorType: ConnectorType,
        enabled: boolean,
    ): Promise<ConnectorConfigRecord> {
        return this.updateConfig(ownerId, connectorType, { enabled });
    }

    /**
     * Report connector status. **The only sanctioned way `status` is written** —
     * it is deliberately excluded from the user-facing config write shapes so an
     * end-user can't fake a state (e.g. 'verified'). Intended for the connector
     * itself, via a privileged (system-auth) path wired in the telephony
     * migration. Shallow-merges onto existing status and stamps its `updatedAt`.
     * Throws `NotFoundError` if no config exists.
     */
    async reportStatus(
        ownerId: string,
        connectorType: ConnectorType,
        status: Partial<ConnectorStatus>,
    ): Promise<ConnectorConfigRecord> {
        const existing = await this.deps.getConfig(ownerId, connectorType);
        if (!existing) {
            throw new NotFoundError(`No ${connectorType} connector config for this owner`);
        }
        const now = this.deps.now();
        const nextStatus: ConnectorStatus = { ...existing.status, ...status, updatedAt: now };
        const merged: ConnectorConfigRecord = { ...existing, status: nextStatus, updatedAt: now };
        const validated = ConnectorConfigRecordSchema.parse(merged);
        await this.deps.updateConfig(ownerId, connectorType, { status: nextStatus, updatedAt: now });
        return validated;
    }

    /**
     * Read just the connector's status. Returns null if no config exists (the
     * route maps that to 404).
     */
    async getStatus(ownerId: string, connectorType: ConnectorType): Promise<ConnectorStatus | null> {
        const config = await this.deps.getConfig(ownerId, connectorType);
        return config ? config.status : null;
    }

    /** Delete an owner's config for a connector. No-op if none exists. */
    async deleteConfig(ownerId: string, connectorType: ConnectorType): Promise<void> {
        await this.deps.deleteConfig(ownerId, connectorType);
    }
}
