import { describe, it, expect, vi } from 'vitest';
import { authorityNotRegistered } from './did-registry';
import { SpaceService, spaceUri } from './spaces';
import type { SpaceDependencies } from '../ports/space-dependencies';
import type { SpaceRecord } from 'shared/types/spaces';

const APP = 'did:web:bardcast.example';
const TABLE = 'did:plc:abcdefghijklmnopqrstuvwx';
const idOf = (originAppId: string, k: { type: string; skey: string; authority?: string }) =>
    `${originAppId}${k.authority ? `@${k.authority}` : ''}/${k.type}/${k.skey}`;

function makeDeps(): SpaceDependencies & { stored: Map<string, SpaceRecord> } {
    const stored = new Map<string, SpaceRecord>();
    return {
        stored,
        getAppDid: () => APP,
        getSpace: vi.fn(async (originAppId, k) => stored.get(idOf(originAppId, k)) ?? null),
        assertWritableAuthority: vi.fn(async (_originAppId: string, did: string) => {
            if (did !== TABLE) throw authorityNotRegistered(did);
        }),
        putSpace: vi.fn(async (input) => {
            const id = idOf(input.originAppId, input.key);
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
        // Occupied keys stand in for a space that still holds posts.
        deleteSpace: vi.fn(async (originAppId, k) => {
            const id = idOf(originAppId, k);
            if (!stored.has(id)) return 'absent' as const;
            if (occupied.has(id)) return 'not-empty' as const;
            stored.delete(id);
            return 'deleted' as const;
        }),
    };
}

const occupied = new Set<string>();

describe('SpaceService', () => {
    const key = { type: 'game.bardcast.space.player', skey: 'did:plc:abc123player' };

    it('creates a space and returns its view, with the tenant as authority', async () => {
        const svc = new SpaceService(makeDeps());
        const view = await svc.putSpace({ originAppId: 'bardcast', key, readPolicy: 'managing-app', writePolicy: 'managing-app' });
        expect(view).toEqual({
            uri: `at://${APP}/space/game.bardcast.space.player/did:plc:abc123player`,
            authority: APP,
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

    it('deletes an empty space, answers false for an absent one, and 409s one that holds posts', async () => {
        const deps = makeDeps();
        const svc = new SpaceService(deps);
        await svc.putSpace({ originAppId: 'bardcast', key, readPolicy: 'public', writePolicy: 'public' });
        const full = { ...key, skey: 'did:plc:fullplayer' };
        await svc.putSpace({ originAppId: 'bardcast', key: full, readPolicy: 'public', writePolicy: 'public' });
        occupied.add(`bardcast/${full.type}/${full.skey}`);

        await expect(svc.deleteSpace('bardcast', key)).resolves.toBe(true);
        await expect(svc.deleteSpace('bardcast', key)).resolves.toBe(false);
        await expect(svc.deleteSpace('bardcast', full)).rejects.toMatchObject({ status: 409, code: 'SPACE_NOT_EMPTY' });
        await expect(svc.deleteSpace('bardcast', { ...key, skey: 'has space' })).rejects.toMatchObject({ status: 400 });
    });
});

describe('SpaceService under another authority (did-plc-and-multi-did-tenancy.md §3)', () => {
    const key = { type: 'game.bardcast.space.campaign', skey: 'thornwood' };

    it("creates a space under a registered DID, keyed apart from the app DID's", async () => {
        const deps = makeDeps();
        const svc = new SpaceService(deps);
        const mine = await svc.putSpace({ originAppId: 'bardcast', key, readPolicy: 'managing-app', writePolicy: 'managing-app' });
        const table = await svc.putSpace({
            originAppId: 'bardcast',
            key: { ...key, authority: TABLE },
            readPolicy: 'managing-app',
            writePolicy: 'managing-app',
        });
        expect(mine.authority).toBe(APP);
        expect(table).toMatchObject({ authority: TABLE, uri: `at://${TABLE}/space/${key.type}/${key.skey}` });
        expect(deps.stored.size).toBe(2);
        expect(deps.assertWritableAuthority).toHaveBeenCalledTimes(1);
        await expect(svc.getSpace('bardcast', { ...key, authority: TABLE })).resolves.toMatchObject({ authority: TABLE });
    });

    it('treats naming the app DID as naming none', async () => {
        const deps = makeDeps();
        const svc = new SpaceService(deps);
        await svc.putSpace({ originAppId: 'bardcast', key: { ...key, authority: APP }, readPolicy: 'public', writePolicy: 'public' });
        expect(deps.assertWritableAuthority).not.toHaveBeenCalled();
        await expect(svc.getSpace('bardcast', key)).resolves.toMatchObject({ authority: APP });
    });

    it("refuses an authority the tenant hasn't registered, or one that isn't a DID", async () => {
        const svc = new SpaceService(makeDeps());
        const other = 'did:plc:zyxwvutsrqponmlkjihgfedc';
        await expect(
            svc.putSpace({ originAppId: 'bardcast', key: { ...key, authority: other }, readPolicy: 'public', writePolicy: 'public' }),
        ).rejects.toMatchObject({ status: 400, code: 'AUTHORITY_NOT_REGISTERED' });
        await expect(svc.getSpace('bardcast', { ...key, authority: 'nope' })).rejects.toMatchObject({ status: 400 });
    });
});
