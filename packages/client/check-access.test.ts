import { describe, it, expect, vi } from 'vitest';
import { handleCheckAccess, CHECK_ACCESS_NSID } from './check-access';

describe('handleCheckAccess', () => {
    it('exports the November 12 managedspace NSID', () => {
        expect(CHECK_ACCESS_NSID).toBe('com.atproto.managedspace.checkAccess');
    });

    it('405s non-GET requests and 400s when space is missing', async () => {
        const decide = vi.fn();

        const post = await handleCheckAccess(new Request('https://app.example/xrpc/checkAccess', { method: 'POST' }), {
            decide,
        });
        expect(post.status).toBe(405);

        const noSpace = await handleCheckAccess(new Request('https://app.example/xrpc/checkAccess'), { decide });
        expect(noSpace.status).toBe(400);
        expect((await noSpace.json()).error).toBe('InvalidRequest');
        expect(decide).not.toHaveBeenCalled();
    });

    it('401s when verifyAuth rejects and forwards callerDid when it succeeds', async () => {
        const decide = vi.fn().mockResolvedValue({ read: true, write: false });

        const denied = await handleCheckAccess(
            new Request('https://app.example/xrpc/checkAccess?space=at:space/did:plc:g/t/k'),
            {
                verifyAuth: async () => ({ ok: false, message: 'Bad service JWT' }),
                decide,
            },
        );
        expect(denied.status).toBe(401);
        expect(await denied.json()).toEqual({ error: 'AuthenticationRequired', message: 'Bad service JWT' });
        expect(decide).not.toHaveBeenCalled();

        const allowed = await handleCheckAccess(
            new Request(
                'https://app.example/xrpc/checkAccess?space=at:space/did:plc:g/t/k&repo=did:plc:u1&clientId=https://app.example/client.json',
                { headers: { authorization: 'Bearer jwt' } },
            ),
            {
                verifyAuth: async (auth) =>
                    auth === 'Bearer jwt' ? { ok: true, iss: 'did:plc:g' } : { ok: false },
                decide,
            },
        );
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toEqual({ read: true, write: false });
        expect(decide).toHaveBeenCalledWith(
            {
                space: 'at:space/did:plc:g/t/k',
                repo: 'did:plc:u1',
                clientId: 'https://app.example/client.json',
            },
            { callerDid: 'did:plc:g' },
        );
    });
});
