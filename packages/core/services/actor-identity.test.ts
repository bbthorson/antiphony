import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActorIdentityService } from './actor-identity';
import type { ActorIdentityDependencies } from '../ports/actor-identity-dependencies';
import type { ActorIdentityRecord } from 'shared/types/actor-identity';

function makeDeps(overrides: Partial<ActorIdentityDependencies> = {}): ActorIdentityDependencies {
    return {
        upsertIdentity: vi.fn(async (originAppId, actorId, fields) => ({
            id: actorId, originAppId, ...fields, updatedAt: new Date('2026-07-02T00:00:00Z'),
        } as ActorIdentityRecord)),
        getIdentity: vi.fn(async () => null),
        now: vi.fn(() => new Date('2026-07-02T00:00:00Z')),
        ...overrides,
    };
}

describe('ActorIdentityService.registerIdentity', () => {
    let deps: ActorIdentityDependencies;
    let svc: ActorIdentityService;
    beforeEach(() => { deps = makeDeps(); svc = new ActorIdentityService(deps); });

    it('rejects an assertion with neither did nor handle', async () => {
        await expect(svc.registerIdentity('vox-pop', 'u1', {})).rejects.toMatchObject({ status: 400 });
        expect(deps.upsertIdentity).not.toHaveBeenCalled();
    });

    it('rejects a malformed DID', async () => {
        await expect(svc.registerIdentity('vox-pop', 'u1', { did: 'not-a-did' })).rejects.toMatchObject({ status: 400 });
        expect(deps.upsertIdentity).not.toHaveBeenCalled();
    });

    it('accepts a valid did:plc DID and forwards to the store', async () => {
        const rec = await svc.registerIdentity('vox-pop', 'u1', { did: 'did:plc:abc123', handle: 'brad' });
        expect(deps.upsertIdentity).toHaveBeenCalledWith('vox-pop', 'u1', { did: 'did:plc:abc123', handle: 'brad' });
        expect(rec.did).toBe('did:plc:abc123');
    });

    it('accepts a handle-only assertion (no did required)', async () => {
        await svc.registerIdentity('vox-pop', 'u1', { handle: 'brad' });
        expect(deps.upsertIdentity).toHaveBeenCalledWith('vox-pop', 'u1', { handle: 'brad' });
    });
});

describe('ActorIdentityService.getIdentity', () => {
    it('passes through to the store', async () => {
        const deps = makeDeps();
        const svc = new ActorIdentityService(deps);
        await svc.getIdentity('vox-pop', 'u1');
        expect(deps.getIdentity).toHaveBeenCalledWith('vox-pop', 'u1');
    });
});
