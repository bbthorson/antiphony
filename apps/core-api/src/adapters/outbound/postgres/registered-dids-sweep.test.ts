import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/pglite.js';
import { sweepRegisteredDids } from './registered-dids-sweep.js';
import { revalidateRegisteredDids } from '../../../lib/app-did.js';

vi.mock('../../../lib/app-did.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../lib/app-did.js')>()),
    revalidateRegisteredDids: vi.fn(async () => []),
}));

/** The hourly sweep over `tenant_dids` (migration 0004), against PGlite. */

const TABLE = 'did:plc:abcdefghijklmnopqrstuvwx';
const ORG = 'did:plc:zyxwvutsrqponmlkjihgfedc';
const revalidate = vi.mocked(revalidateRegisteredDids);

function fakeLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Parameters<typeof sweepRegisteredDids>[1] & {
        info: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
    };
}

describe('sweepRegisteredDids', () => {
    let db: TestDatabase;

    beforeAll(async () => {
        db = await createTestDatabase();
    });
    afterAll(async () => db.close());
    beforeEach(async () => {
        await db.truncate();
        revalidate.mockClear();
    });

    it('revalidates every registered DID, with its tenant', async () => {
        await db.query(`insert into tenant_dids (did, origin_app_id, role) values ($1, 'bardcast', 'group'), ($2, 'voxpop', 'group')`, [
            TABLE,
            ORG,
        ]);
        await sweepRegisteredDids(db, fakeLogger(), { expectedPdsHost: 'api.antiphony.dev' });

        expect(revalidate).toHaveBeenCalledTimes(1);
        const [dids, opts] = revalidate.mock.calls[0];
        expect([...dids].sort((a, b) => a.did.localeCompare(b.did))).toEqual([
            { did: TABLE, originAppId: 'bardcast' },
            { did: ORG, originAppId: 'voxpop' },
        ]);
        expect(opts).toMatchObject({ expectedPdsHost: 'api.antiphony.dev' });
    });

    it('does nothing when no DID is registered', async () => {
        await sweepRegisteredDids(db, fakeLogger(), { expectedPdsHost: 'api.antiphony.dev' });
        expect(revalidate).not.toHaveBeenCalled();
    });

    it('logs drift as an error', async () => {
        await db.query(`insert into tenant_dids (did, origin_app_id, role) values ($1, 'bardcast', 'group')`, [TABLE]);
        revalidate.mockResolvedValueOnce([{ did: TABLE, originAppId: 'bardcast', reason: 'did-doc-host-mismatch', kind: 'disproof' }]);
        const logger = fakeLogger();
        await sweepRegisteredDids(db, logger, { expectedPdsHost: 'api.antiphony.dev' });
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ drift: [expect.objectContaining({ did: TABLE })] }), expect.any(String));
    });

    it('swallows its own failure, so the rest of the cron still runs', async () => {
        await db.query(`insert into tenant_dids (did, origin_app_id, role) values ($1, 'bardcast', 'group')`, [TABLE]);
        revalidate.mockRejectedValueOnce(new Error('no ANTIPHONY_PDS_HOST'));
        const logger = fakeLogger();
        await expect(sweepRegisteredDids(db, logger, {})).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalled();
    });
});
