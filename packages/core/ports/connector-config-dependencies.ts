import type { ConnectorConfigRecord, ConnectorType } from 'shared/types/records';

/**
 * Port for the connector-config data layer (Plan B control plane).
 *
 * The `ConnectorConfigRecord` lives at Firestore
 * `connector_configs/{ownerId}/items/{connectorType}` in the default Firebase
 * binding — one config doc per (owner, connectorType). This interface is
 * portable: alternative stores can implement it without touching the service
 * or route handlers.
 *
 * Scope: pure CRUD on the config envelope. Core does not interpret `settings`
 * (opaque blob) — the connector app validates its own settings shape on read.
 * Secrets are never stored here; `secretRef` points into a secret store.
 *
 * See `specs/plan-b-connector-boundaries.md`.
 */
export interface ConnectorConfigDependencies {
    /** Read the owner's config for a connector. Returns `null` if none exists. */
    getConfig(ownerId: string, connectorType: ConnectorType): Promise<ConnectorConfigRecord | null>;

    /**
     * Write the full config. Idempotent — overwrites any existing config for
     * this (owner, connectorType).
     */
    saveConfig(record: ConnectorConfigRecord): Promise<void>;

    /**
     * Apply a partial update to an existing config. Throws (via the service)
     * if no config exists. Never receives `createdAt`; `updatedAt` is stamped
     * by the service.
     */
    updateConfig(
        ownerId: string,
        connectorType: ConnectorType,
        updates: Partial<ConnectorConfigRecord>,
    ): Promise<void>;

    /** Delete the owner's config for a connector. No-op if none exists. */
    deleteConfig(ownerId: string, connectorType: ConnectorType): Promise<void>;

    /** Server-side clock for stamping `createdAt` / `updatedAt`. Injectable for tests. */
    now(): Date;
}
