import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SpaceRecord } from 'shared/types/spaces';

/**
 * Route tests for `/api/v1/spaces`. The real `SpaceService` over an in-memory
 * store, so key validation and the 404 are the service's own; the Postgres
 * adapter has its own suite.
 */

const { SpaceService } = await import('@antiphony/core/services/spaces');
const rows = new Map<string, SpaceRecord>();
const spaceService = new SpaceService({
    getAppDid: () => 'did:web:test-app.example',
    getSpace: async (originAppId, key) => rows.get(`${originAppId}|${key.type}|${key.skey}`) ?? null,
    putSpace: async (input) => {
        const id = `${input.originAppId}|${input.key.type}|${input.key.skey}`;
        const prior = rows.get(id);
        const row: SpaceRecord = {
            originAppId: input.originAppId,
            ...input.key,
            readPolicy: input.readPolicy,
            writePolicy: input.writePolicy,
            ...(input.managingAppEndpoint ? { managingAppEndpoint: input.managingAppEndpoint } : {}),
            createdAt: prior?.createdAt ?? new Date('2026-10-08T00:00:00Z'),
            updatedAt: new Date('2026-10-08T00:00:00Z'),
        };
        rows.set(id, row);
        return row;
    },
});

vi.mock('../../../composition.js', () => ({
    servicesFor: () => ({
        spaceService,
        rateLimitStore: { hit: async () => 'under' as const },
    }),
}));

const SERVICE_TOKEN = 'svc-tok-abcdefghijklmnopqrstuvwxyz012345';
const OTHER_TOKEN = 'svc-tok-zyxwvutsrqponmlkjihgfedcba543210';
process.env.LOG_LEVEL = 'silent';
process.env.ANTIPHONY_APP_TOKENS = `test-app:${SERVICE_TOKEN},other-app:${OTHER_TOKEN}`;

const { app } = await import('../../../app.js');
const { seedValidatedPins } = await import('../../../lib/testing/seed-pins.js');
await seedValidatedPins({ 'test-app': 'did:web:test-app.example', 'other-app': 'did:web:other-app.example' });

const PATH = '/api/v1/spaces/game.bardcast.space.campaign/thornwood';
const put = (body: unknown, token = SERVICE_TOKEN, path = PATH) =>
    app().request(path, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
const get = (token = SERVICE_TOKEN, path = PATH) =>
    app().request(path, { headers: { authorization: `Bearer ${token}` } });

describe('/api/v1/spaces', () => {
    beforeEach(() => {
        rows.clear();
        process.env.ANTIPHONY_PLAYBACK_SECRET = 'test-playback-secret-0123456789abcdef';
    });
    afterEach(() => {
        delete process.env.ANTIPHONY_PLAYBACK_SECRET;
    });

    it('401s without a service token', async () => {
        expect((await app().request(PATH)).status).toBe(401);
    });

    it('creates a space with the protocol defaults and reads it back', async () => {
        const res = await put({});
        expect(res.status).toBe(200);
        const { data } = await res.json();
        expect(data).toMatchObject({
            uri: 'at://did:web:test-app.example/space/game.bardcast.space.campaign/thornwood',
            type: 'game.bardcast.space.campaign',
            skey: 'thornwood',
            readPolicy: 'member-list',
            writePolicy: 'member-list',
        });
        expect((await (await get()).json()).data).toEqual(data);
    });

    it('replaces, not merges: an omitted policy goes back to the default', async () => {
        await put({ readPolicy: 'public', writePolicy: 'managing-app' });
        const { data } = await (await put({ writePolicy: 'managing-app' })).json();
        expect(data).toMatchObject({ readPolicy: 'member-list', writePolicy: 'managing-app' });
    });

    it('takes a DID as the space key, as a per-player space does', async () => {
        const res = await put({}, SERVICE_TOKEN, '/api/v1/spaces/game.bardcast.space.player/did:plc:alice');
        expect(res.status).toBe(200);
        expect((await res.json()).data.uri).toBe('at://did:web:test-app.example/space/game.bardcast.space.player/did:plc:alice');
    });

    it('400s a type that is not an NSID, or an unknown policy', async () => {
        expect((await put({}, SERVICE_TOKEN, '/api/v1/spaces/not-an-nsid/thornwood')).status).toBe(400);
        expect((await put({ readPolicy: 'everyone' })).status).toBe(400);
    });

    it("404s a space the tenant doesn't have, including another tenant's", async () => {
        expect((await get()).status).toBe(404);
        await put({});
        expect((await get(OTHER_TOKEN)).status).toBe(404);
    });

    it('refuses to create a space when it could not keep its audio private', async () => {
        delete process.env.ANTIPHONY_PLAYBACK_SECRET;
        const res = await put({});
        expect(res.status).toBe(503);
        expect((await res.json()).error.code).toBe('SPACES_UNAVAILABLE');
        expect(rows.size).toBe(0);
    });
});
