import { describe, it, expect } from 'vitest';
import { ConnectorConfigService, type ConnectorConfigInput } from './connector-config';
import type { ConnectorConfigDependencies } from '../ports/connector-config-dependencies';
import type { ConnectorConfigRecord, ConnectorType } from 'shared/types/records';
import { NotFoundError } from 'shared/errors';

/**
 * Unit tests for ConnectorConfigService — the logic the route tests mock out:
 * envelope stamping on create, settings deep-merge + updatedAt on update, the
 * NotFoundError path, enable/disable, status read, and — crucially — that
 * `status` is connector-owned (set only via reportStatus, never by saveConfig /
 * updateConfig) and preserved across user-facing config writes.
 */

const NOW = new Date('2026-06-17T12:00:00.000Z');
const LATER = new Date('2026-06-18T12:00:00.000Z');

function key(ownerId: string, type: ConnectorType) {
    return `${ownerId}:${type}`;
}

function fakeDeps(initial: ConnectorConfigRecord[] = [], clock = () => NOW) {
    const store = new Map<string, ConnectorConfigRecord>(
        initial.map((r) => [key(r.ownerId, r.connectorType), r]),
    );
    const deps: ConnectorConfigDependencies = {
        async getConfig(ownerId, type) {
            return store.get(key(ownerId, type)) ?? null;
        },
        async saveConfig(record) {
            store.set(key(record.ownerId, record.connectorType), record);
        },
        async updateConfig(ownerId, type, updates) {
            const existing = store.get(key(ownerId, type));
            if (existing) store.set(key(ownerId, type), { ...existing, ...updates });
        },
        async deleteConfig(ownerId, type) {
            store.delete(key(ownerId, type));
        },
        now() {
            return clock();
        },
    };
    return { deps, store };
}

const input: ConnectorConfigInput = {
    settings: { phoneNumber: '+15551234567', tier: 'free' },
    secretRef: null,
    enabled: false,
};

describe('ConnectorConfigService.saveConfig', () => {
    it('stamps the envelope and defaults status to unconfigured on first create', async () => {
        const { deps, store } = fakeDeps();
        const svc = new ConnectorConfigService(deps);

        const saved = await svc.saveConfig('u-1', 'telephony', input);

        expect(saved.connectorType).toBe('telephony');
        expect(saved.ownerId).toBe('u-1');
        expect(saved.createdAt).toEqual(NOW);
        expect(saved.updatedAt).toEqual(NOW);
        expect(saved.status).toEqual({ state: 'unconfigured' });
        expect(saved.settings).toEqual({ phoneNumber: '+15551234567', tier: 'free' });
        expect(store.get('u-1:telephony')).toEqual(saved);
    });

    it('keeps settings opaque (arbitrary keys preserved)', async () => {
        const { deps } = fakeDeps();
        const svc = new ConnectorConfigService(deps);

        const saved = await svc.saveConfig('u-1', 'telephony', {
            ...input,
            settings: { anything: { nested: true }, count: 3 },
        });
        expect(saved.settings).toEqual({ anything: { nested: true }, count: 3 });
    });

    it('preserves connector-owned status and original createdAt on replace', async () => {
        // Seed + advance the connector to an 'active' status.
        const { deps } = fakeDeps();
        const svc = new ConnectorConfigService(deps);
        await svc.saveConfig('u-1', 'telephony', input);
        await svc.reportStatus('u-1', 'telephony', { state: 'active' });

        // A later user-facing PUT must not reset status or createdAt.
        const replaced = await svc.saveConfig('u-1', 'telephony', { ...input, enabled: true });
        expect(replaced.status.state).toBe('active');
        expect(replaced.createdAt).toEqual(NOW);
        expect(replaced.enabled).toBe(true);
    });
});

describe('ConnectorConfigService.updateConfig', () => {
    it('shallow-merges settings (does not drop unrelated keys)', async () => {
        const seed = await new ConnectorConfigService(fakeDeps().deps).saveConfig('u-1', 'telephony', input);
        const { deps } = fakeDeps([seed], () => LATER);
        const svc = new ConnectorConfigService(deps);

        const updated = await svc.updateConfig('u-1', 'telephony', { settings: { tier: 'pro' } });

        expect(updated.settings).toEqual({ phoneNumber: '+15551234567', tier: 'pro' });
        expect(updated.updatedAt).toEqual(LATER);
        expect(updated.createdAt).toEqual(NOW);
    });

    it('throws NotFoundError when no config exists', async () => {
        const { deps } = fakeDeps();
        const svc = new ConnectorConfigService(deps);
        await expect(svc.updateConfig('u-x', 'telephony', { enabled: true })).rejects.toBeInstanceOf(
            NotFoundError,
        );
    });
});

describe('ConnectorConfigService.setEnabled', () => {
    it('flips enabled', async () => {
        const seed = await new ConnectorConfigService(fakeDeps().deps).saveConfig('u-1', 'telephony', input);
        const { deps } = fakeDeps([seed]);
        const svc = new ConnectorConfigService(deps);

        expect((await svc.setEnabled('u-1', 'telephony', true)).enabled).toBe(true);
        expect((await svc.setEnabled('u-1', 'telephony', false)).enabled).toBe(false);
    });

    it('throws NotFoundError when no config exists', async () => {
        const { deps } = fakeDeps();
        const svc = new ConnectorConfigService(deps);
        await expect(svc.setEnabled('u-x', 'telephony', true)).rejects.toBeInstanceOf(NotFoundError);
    });
});

describe('ConnectorConfigService.reportStatus', () => {
    it('merges status and stamps its updatedAt', async () => {
        const seed = await new ConnectorConfigService(fakeDeps().deps).saveConfig('u-1', 'telephony', input);
        const { deps } = fakeDeps([seed], () => LATER);
        const svc = new ConnectorConfigService(deps);

        const updated = await svc.reportStatus('u-1', 'telephony', { state: 'error', detail: 'verify failed' });
        expect(updated.status.state).toBe('error');
        expect(updated.status.detail).toBe('verify failed');
        expect(updated.status.updatedAt).toEqual(LATER);
    });

    it('throws NotFoundError when no config exists', async () => {
        const { deps } = fakeDeps();
        const svc = new ConnectorConfigService(deps);
        await expect(svc.reportStatus('u-x', 'telephony', { state: 'active' })).rejects.toBeInstanceOf(
            NotFoundError,
        );
    });

    it('merges status.data so reporting one field does not drop the others', async () => {
        const seed = await new ConnectorConfigService(fakeDeps().deps).saveConfig('u-1', 'telephony', input);
        const { deps } = fakeDeps([seed]);
        const svc = new ConnectorConfigService(deps);

        await svc.reportStatus('u-1', 'telephony', { data: { verificationAttempts: 2 } });
        const after = await svc.reportStatus('u-1', 'telephony', { data: { verificationStatus: 'verified' } });

        expect(after.status.data).toEqual({ verificationAttempts: 2, verificationStatus: 'verified' });
    });

    it('optionally flips enabled (connector-driven activation on verify)', async () => {
        const seed = await new ConnectorConfigService(fakeDeps().deps).saveConfig('u-1', 'telephony', input);
        const { deps } = fakeDeps([seed]);
        const svc = new ConnectorConfigService(deps);

        const updated = await svc.reportStatus('u-1', 'telephony', { state: 'active' }, { enabled: true });
        expect(updated.enabled).toBe(true);
        expect(updated.status.state).toBe('active');
    });
});

describe('ConnectorConfigService.getStatus / getConfig / deleteConfig', () => {
    it('getStatus returns the status sub-object, or null when absent', async () => {
        const { deps } = fakeDeps();
        const svc = new ConnectorConfigService(deps);
        await svc.saveConfig('u-1', 'telephony', input);
        await svc.reportStatus('u-1', 'telephony', { state: 'active' });

        expect((await svc.getStatus('u-1', 'telephony'))?.state).toBe('active');
        expect(await svc.getStatus('u-x', 'telephony')).toBeNull();
    });

    it('deleteConfig removes the record', async () => {
        const seed = await new ConnectorConfigService(fakeDeps().deps).saveConfig('u-1', 'telephony', input);
        const { deps } = fakeDeps([seed]);
        const svc = new ConnectorConfigService(deps);

        await svc.deleteConfig('u-1', 'telephony');
        expect(await svc.getConfig('u-1', 'telephony')).toBeNull();
    });
});
