import { describe, it, expect } from 'vitest';
import { ScreeningService } from './screening';
import type { ScreeningRuleDependencies } from '../ports/screening-dependencies';
import type { ScreeningRuleRecord } from 'shared/types/records';

/**
 * Unit tests for ScreeningService — the logic the route tests mock out:
 * field stamping on create, immutable fields on update, the NotFoundError
 * path, and the Phase-2 `getActiveRules` expiry filter.
 */

const NOW = new Date('2026-06-06T12:00:00.000Z');

function fakeDeps(initial: ScreeningRuleRecord[] = []) {
    const store = new Map<string, ScreeningRuleRecord>(initial.map((r) => [r.id, r]));
    let counter = 0;
    const deps: ScreeningRuleDependencies = {
        async listRules() {
            return [...store.values()];
        },
        async getRule(_uid, ruleId) {
            return store.get(ruleId) ?? null;
        },
        async createRule(_uid, rule) {
            store.set(rule.id, rule);
        },
        async updateRule(_uid, ruleId, updates) {
            const existing = store.get(ruleId);
            if (existing) store.set(ruleId, { ...existing, ...updates });
        },
        async deleteRule(_uid, ruleId) {
            store.delete(ruleId);
        },
        now() {
            return NOW;
        },
        newId() {
            counter += 1;
            return `id-${counter}`;
        },
    };
    return { deps, store };
}

describe('ScreeningService', () => {
    it('createRule stamps id/ownerId/createdAt and source=manual', async () => {
        const { deps, store } = fakeDeps();
        const svc = new ScreeningService(deps);

        const rule = await svc.createRule('viewer-1', { e164: '+15551234567', action: 'allow' });

        expect(rule.id).toBe('id-1');
        expect(rule.ownerId).toBe('viewer-1');
        expect(rule.source).toBe('manual');
        expect(rule.label).toBeNull();
        expect(rule.expiresAt).toBeNull();
        expect(rule.createdAt).toEqual(NOW);
        expect(store.get('id-1')).toEqual(rule);
    });

    it('createRule converts a string expiresAt into a Date', async () => {
        const { deps } = fakeDeps();
        const svc = new ScreeningService(deps);

        const rule = await svc.createRule('viewer-1', {
            e164: '+15551234567',
            action: 'allow',
            label: 'Delta',
            expiresAt: '2026-06-06T13:00:00.000Z',
        });

        expect(rule.label).toBe('Delta');
        expect(rule.expiresAt).toEqual(new Date('2026-06-06T13:00:00.000Z'));
    });

    it('updateRule throws NotFoundError for an unknown rule', async () => {
        const { deps } = fakeDeps();
        const svc = new ScreeningService(deps);
        await expect(svc.updateRule('viewer-1', 'missing', { action: 'screen' })).rejects.toThrow(
            'Screening rule not found',
        );
    });

    it('updateRule applies changes and preserves immutable fields', async () => {
        const seed: ScreeningRuleRecord = {
            id: 'r1',
            ownerId: 'viewer-1',
            e164: '+15551234567',
            label: null,
            action: 'allow',
            source: 'manual',
            expiresAt: null,
            createdAt: NOW,
        };
        const { deps } = fakeDeps([seed]);
        const svc = new ScreeningService(deps);

        const updated = await svc.updateRule('viewer-1', 'r1', { action: 'screen', label: 'Spam' });
        expect(updated.action).toBe('screen');
        expect(updated.label).toBe('Spam');
        expect(updated.id).toBe('r1');
        expect(updated.source).toBe('manual');
        expect(updated.createdAt).toEqual(NOW);
    });

    it('getActiveRules filters out expired rules', async () => {
        const permanent: ScreeningRuleRecord = {
            id: 'perm', ownerId: 'v', e164: '+15550000001', label: null,
            action: 'allow', source: 'manual', expiresAt: null, createdAt: NOW,
        };
        const future: ScreeningRuleRecord = {
            id: 'future', ownerId: 'v', e164: '+15550000002', label: null,
            action: 'allow', source: 'callback', expiresAt: new Date(NOW.getTime() + 3_600_000), createdAt: NOW,
        };
        const expired: ScreeningRuleRecord = {
            id: 'expired', ownerId: 'v', e164: '+15550000003', label: null,
            action: 'allow', source: 'callback', expiresAt: new Date(NOW.getTime() - 1), createdAt: NOW,
        };
        const { deps } = fakeDeps([permanent, future, expired]);
        const svc = new ScreeningService(deps);

        const active = await svc.getActiveRules('v', NOW);
        const ids = active.map((r) => r.id).sort();
        expect(ids).toEqual(['future', 'perm']);
    });
});
