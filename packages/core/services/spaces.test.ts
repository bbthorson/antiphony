import { describe, it, expect, vi } from 'vitest';
import { SpaceService, spaceUri } from './spaces';
import type { SpaceDependencies } from '../ports/space-dependencies';
import type { SpaceRecord } from 'shared/types/spaces';

const APP = 'did:web:bardcast.example';

function makeDeps(): SpaceDependencies & { stored: Map<string, SpaceRecord> } {
    const stored = new Map<string, SpaceRecord>();
    return {
        stored,
        getAppDid: () => APP,
        getSpace: vi.fn(async (originAppId, k) => stored.get(`${originAppId}/${k.type}/${k.skey}`) ?? null),
        putSpace: vi.fn(async (input) => {
            const id = `${input.originAppId}/${input.key.type}/${input.key.skey}`;
            const prior = stored.get(id);
            const record: SpaceRecord = {
                originAppId: input.originAppId,
                ...input.key,
                readPolicy: input.readPolicy,
                writePolicy: input.writePolicy,
                ...(input.managingAppEndpoint ? { managingAppEndpoint: input.managingAppEndpoint } : {}),
                createdAt: prior?.createdAt ?? new Date('2026-10-08T00:00:00Z'),
                updatedAt: new Date('2026-10-08T01:00:00Z'),
            };
            stored.set(id, record);
            return record;
        }),
    };
}

describe('SpaceService', () => {
    const key = { type: 'game.bardcast.space.player', skey: 'did:plc:abc123player' };

    it('creates a space and returns its view, with the tenant as authority', async () => {
        const svc = new SpaceService(makeDeps());
        const view = await svc.putSpace({ originAppId: 'bardcast', key, readPolicy: 'managing-app', writePolicy: 'managing-app' });
        expect(view).toEqual({
            uri: `at://${APP}/space/game.bardcast.space.player/did:plc:abc123player`,
            ...key,
            readPolicy: 'managing-app',
            writePolicy: 'managing-app',
            createdAt: '2026-10-08T00:00:00.000Z',
            updatedAt: '2026-10-08T01:00:00.000Z',
        });
        expect(spaceUri(APP, key)).toBe(view.uri);
    });

    it('reads a space back, and 404s one the tenant does not have', async () => {
        const deps = makeDeps();
        const svc = new SpaceService(deps);
        await svc.putSpace({ originAppId: 'bardcast', key, readPolicy: 'public', writePolicy: 'member-list' });
        await expect(svc.getSpace('bardcast', key)).resolves.toMatchObject({ readPolicy: 'public' });
        await expect(svc.getSpace('vox-pop', key)).rejects.toMatchObject({ status: 404 });
    });

    it('refuses a key that is not atproto syntax, before it reaches storage', async () => {
        const deps = makeDeps();
        const svc = new SpaceService(deps);
        for (const bad of [{ ...key, type: 'campaign' }, { ...key, skey: 'has space' }]) {
            await expect(svc.putSpace({ originAppId: 'bardcast', key: bad, readPolicy: 'public', writePolicy: 'public' })).rejects.toMatchObject({ status: 400 });
        }
        expect(deps.putSpace).not.toHaveBeenCalled();
    });
});
