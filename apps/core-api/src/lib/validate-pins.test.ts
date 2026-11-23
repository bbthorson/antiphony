import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { stripJsonComments, runValidatePins } from '../../scripts/validate-pins.js';
import type { ValidatedPin } from './app-did.js';

function makeLog() {
    return {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
}

function makePin(overrides: Partial<ValidatedPin> = {}): ValidatedPin {
    return {
        originAppId: 'voxpop',
        did: 'did:web:did.voxpop.audio',
        custody: { kind: 'space-host', endpoint: 'https://api.antiphony.dev' },
        document: { id: 'did:web:did.voxpop.audio' },
        documentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        validatedAt: 1_700_000_000_000,
        ...overrides,
    };
}

describe('stripJsonComments', () => {
    it('strips line and block comments while preserving URLs and escaped quotes inside strings', () => {
        const jsonc = `{
            // a line comment
            "url": "https://api.antiphony.dev/v1",
            /* a block comment
               spanning lines */
            "quoted": "say \\"hello // not a comment /* still not */\\""
        }`;
        const parsed = JSON.parse(stripJsonComments(jsonc)) as Record<string, string>;
        expect(parsed).toEqual({
            url: 'https://api.antiphony.dev/v1',
            quoted: 'say "hello // not a comment /* still not */"',
        });
    });

    it('parses the committed apps/core-api/wrangler.jsonc', () => {
        const raw = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
        const parsed = JSON.parse(stripJsonComments(raw)) as { name: string; vars?: Record<string, string> };
        expect(parsed.name).toBe('antiphony-core-api');
        expect(parsed.vars?.ANTIPHONY_PDS_HOST).toBeTruthy();
        expect(parsed.vars?.ANTIPHONY_APP_DIDS).toBeTruthy();
    });
});

describe('runValidatePins', () => {
    it('returns empty and warns without calling validateAllPins when ANTIPHONY_APP_DIDS is unset', async () => {
        const validateAllPins = vi.fn();
        const log = makeLog();

        const result = await runValidatePins({
            env: {},
            vars: {},
            validateAllPins,
            log,
        });

        expect(result).toEqual({ status: 'empty', provedCount: 0, legacyCount: 0 });
        expect(validateAllPins).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ANTIPHONY_APP_DIDS is empty or unset'));
    });

    it('passes when every resolved pin matches its acknowledged JCS hash', async () => {
        const pin = makePin();
        const validateAllPins = vi.fn().mockResolvedValue(new Map([[pin.originAppId, pin]]));
        const log = makeLog();

        const result = await runValidatePins({
            env: {},
            vars: {
                ANTIPHONY_PDS_HOST: 'api.antiphony.dev',
                ANTIPHONY_APP_DIDS: 'voxpop:did:web:did.voxpop.audio',
                ANTIPHONY_APP_DID_DOC_HASHES: `voxpop:${pin.documentHash}`,
            },
            validateAllPins,
            log,
        });

        expect(result).toEqual({ status: 'ok', provedCount: 1, legacyCount: 0 });
        expect(validateAllPins).toHaveBeenCalledWith({
            expectedPdsHost: 'api.antiphony.dev',
            raw: 'voxpop:did:web:did.voxpop.audio',
        });
        expect(log.warn).not.toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
    });

    it('prefers environment variables over wrangler.jsonc vars', async () => {
        const pin = makePin({
            originAppId: 'bardcast',
            did: 'did:web:bardcast.example',
            documentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        });
        const validateAllPins = vi.fn().mockResolvedValue(new Map([[pin.originAppId, pin]]));
        const log = makeLog();

        await runValidatePins({
            env: {
                ANTIPHONY_PDS_HOST: 'staging.antiphony.dev',
                ANTIPHONY_APP_DIDS: 'bardcast:did:web:bardcast.example',
                ANTIPHONY_APP_DID_DOC_HASHES: `bardcast:${pin.documentHash}`,
            },
            vars: {
                ANTIPHONY_PDS_HOST: 'api.antiphony.dev',
                ANTIPHONY_APP_DIDS: 'voxpop:did:web:did.voxpop.audio',
                ANTIPHONY_APP_DID_DOC_HASHES: 'voxpop:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
            validateAllPins,
            log,
        });

        expect(validateAllPins).toHaveBeenCalledWith({
            expectedPdsHost: 'staging.antiphony.dev',
            raw: 'bardcast:did:web:bardcast.example',
        });
    });

    it('warns when ANTIPHONY_PDS_HOST is unset (weak custody check)', async () => {
        const pin = makePin();
        const validateAllPins = vi.fn().mockResolvedValue(new Map([[pin.originAppId, pin]]));
        const log = makeLog();

        await runValidatePins({
            env: {},
            vars: {
                ANTIPHONY_APP_DIDS: 'voxpop:did:web:did.voxpop.audio',
                ANTIPHONY_APP_DID_DOC_HASHES: `voxpop:${pin.documentHash}`,
            },
            validateAllPins,
            log,
        });

        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ANTIPHONY_PDS_HOST unset'));
    });

    it('fails the gate when a resolved DID document hash differs from the acknowledged baseline', async () => {
        const observed = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
        const expected = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const pin = makePin({ documentHash: observed });
        const validateAllPins = vi.fn().mockResolvedValue(new Map([[pin.originAppId, pin]]));
        const log = makeLog();

        await expect(
            runValidatePins({
                env: {},
                vars: {
                    ANTIPHONY_PDS_HOST: 'api.antiphony.dev',
                    ANTIPHONY_APP_DIDS: 'voxpop:did:web:did.voxpop.audio',
                    ANTIPHONY_APP_DID_DOC_HASHES: `voxpop:${expected}`,
                },
                validateAllPins,
                log,
            }),
        ).rejects.toThrow(/1 tenant DID document\(s\) not acknowledged/);

        expect(log.error).toHaveBeenCalledWith(expect.stringContaining(`CHANGED since it was acknowledged (expected ${expected})`));
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining(`observed ${observed}`));
    });

    it('fails the gate and surfaces every unacknowledged tenant in a single run', async () => {
        const pinA = makePin({
            originAppId: 'voxpop',
            documentHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        });
        const pinB = makePin({
            originAppId: 'bardcast',
            did: 'did:web:bardcast.example',
            documentHash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        });
        const validateAllPins = vi.fn().mockResolvedValue(
            new Map([
                [pinA.originAppId, pinA],
                [pinB.originAppId, pinB],
            ]),
        );
        const log = makeLog();

        await expect(
            runValidatePins({
                env: {},
                vars: {
                    ANTIPHONY_PDS_HOST: 'api.antiphony.dev',
                    ANTIPHONY_APP_DIDS: 'voxpop:did:web:did.voxpop.audio,bardcast:did:web:bardcast.example',
                },
                validateAllPins,
                log,
            }),
        ).rejects.toThrow(/2 tenant DID document\(s\) not acknowledged/);

        expect(log.error).toHaveBeenCalledTimes(2);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('has NO acknowledged baseline'));
    });

    it('propagates validateAllPins errors (unreachable host or disproved custody)', async () => {
        const validateAllPins = vi
            .fn()
            .mockRejectedValue(new Error('[app-did] pin validation failed for tenant "voxpop": host unreachable'));
        const log = makeLog();

        await expect(
            runValidatePins({
                env: {},
                vars: {
                    ANTIPHONY_PDS_HOST: 'api.antiphony.dev',
                    ANTIPHONY_APP_DIDS: 'voxpop:did:web:did.voxpop.audio',
                },
                validateAllPins,
                log,
            }),
        ).rejects.toThrow(/host unreachable/);
    });

    it('warns without failing when a tenant still uses the legacy #atproto_pds custody entry', async () => {
        const pin = makePin({
            custody: { kind: 'pds', endpoint: 'https://api.antiphony.dev' },
        });
        const validateAllPins = vi.fn().mockResolvedValue(new Map([[pin.originAppId, pin]]));
        const log = makeLog();

        const result = await runValidatePins({
            env: {},
            vars: {
                ANTIPHONY_PDS_HOST: 'api.antiphony.dev',
                ANTIPHONY_APP_DIDS: 'voxpop:did:web:did.voxpop.audio',
                ANTIPHONY_APP_DID_DOC_HASHES: `voxpop:${pin.documentHash}`,
            },
            validateAllPins,
            log,
        });

        expect(result).toEqual({ status: 'ok', provedCount: 1, legacyCount: 1 });
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('legacy #atproto_pds'));
    });

    it('warns (non-fatally) on tenant registry drift when ANTIPHONY_APP_TOKENS is set', async () => {
        const pin = makePin();
        const validateAllPins = vi.fn().mockResolvedValue(new Map([[pin.originAppId, pin]]));
        const parseAppTokens = vi.fn().mockReturnValue([
            { appId: 'voxpop', token: 't'.repeat(32) },
            { appId: 'orphan', token: 'u'.repeat(32) },
        ]);
        const checkTenantRegistryDrift = vi.fn().mockReturnValue({
            tokensWithoutPin: ['orphan'],
            pinsWithoutToken: [],
        });
        const log = makeLog();

        const result = await runValidatePins({
            env: { ANTIPHONY_APP_TOKENS: `voxpop:${'t'.repeat(32)},orphan:${'u'.repeat(32)}` },
            vars: {
                ANTIPHONY_PDS_HOST: 'api.antiphony.dev',
                ANTIPHONY_APP_DIDS: 'voxpop:did:web:did.voxpop.audio',
                ANTIPHONY_APP_DID_DOC_HASHES: `voxpop:${pin.documentHash}`,
            },
            validateAllPins,
            parseAppTokens,
            checkTenantRegistryDrift,
            log,
        });

        expect(result.status).toBe('ok');
        expect(checkTenantRegistryDrift).toHaveBeenCalledWith(['voxpop', 'orphan']);
        expect(log.warn).toHaveBeenCalledWith('[validate-pins] tenant registry drift:', {
            tokensWithoutPin: ['orphan'],
            pinsWithoutToken: [],
        });
    });
});
