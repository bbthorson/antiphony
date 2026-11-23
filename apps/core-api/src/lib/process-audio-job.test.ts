import { describe, it, expect, vi, beforeEach } from 'vitest';

const processMock = vi.fn();
const audioProcessingServiceCtor = vi.fn();
const ensureTenantPinMock = vi.fn();
const resolveProvidersMock = vi.fn();
const resolveNotifierMock = vi.fn();
const servicesForMock = vi.fn();

vi.mock('@antiphony/core/services/audio-processing', () => ({
    AudioProcessingService: class MockAudioProcessingService {
        constructor(...args: unknown[]) {
            audioProcessingServiceCtor(...args);
        }
        process = processMock;
    },
}));

vi.mock('./app-did.js', () => ({
    ensureTenantPin: ensureTenantPinMock,
}));

vi.mock('./audio-processing.js', () => ({
    resolveProviders: resolveProvidersMock,
    resolveNotifier: resolveNotifierMock,
}));

vi.mock('../composition.js', () => ({
    servicesFor: servicesForMock,
}));

process.env.LOG_LEVEL = 'silent';
process.env.ANTIPHONY_PDS_HOST = 'api.antiphony.dev';

const { runProcessingJob, shouldRetry } = await import('./process-audio-job.js');

const hostedDeps = { kind: 'hosted-deps' };
const remoteDeps = { kind: 'remote-deps' };
const providers = { kind: 'providers' };
const notifier = { kind: 'notifier' };

beforeEach(() => {
    vi.resetAllMocks();
    servicesForMock.mockReturnValue({
        audioProcessingDeps: hostedDeps,
        remoteProcessingDeps: remoteDeps,
    });
    resolveProvidersMock.mockReturnValue(providers);
    resolveNotifierMock.mockReturnValue(notifier);
    ensureTenantPinMock.mockResolvedValue(undefined);
});

describe('shouldRetry', () => {
    it('returns true only for threw outcomes and false for ran and invalid', () => {
        expect(shouldRetry({ outcome: 'threw', err: new Error('db down') })).toBe(true);
        expect(shouldRetry({ outcome: 'ran', ran: true })).toBe(false);
        expect(shouldRetry({ outcome: 'ran', ran: false })).toBe(false);
        expect(shouldRetry({ outcome: 'invalid' })).toBe(false);
    });
});

describe('runProcessingJob', () => {
    it('classifies malformed payloads as invalid (non-retryable) without touching custody or services', async () => {
        const result = await runProcessingJob({ originAppId: '' }, undefined);

        expect(result).toEqual({ outcome: 'invalid' });
        expect(shouldRetry(result)).toBe(false);
        expect(ensureTenantPinMock).not.toHaveBeenCalled();
        expect(servicesForMock).not.toHaveBeenCalled();
    });

    it('proves tenant custody and runs hosted post processing via audioProcessingDeps', async () => {
        processMock.mockResolvedValueOnce(true);
        const pinCache = { get: vi.fn(), put: vi.fn() };

        const result = await runProcessingJob(
            { originAppId: 'voxpop', postId: 'post-1' },
            { PIN_CACHE: pinCache },
            { messageId: 'msg-1' },
        );

        expect(result).toEqual({ outcome: 'ran', ran: true });
        expect(shouldRetry(result)).toBe(false);
        expect(ensureTenantPinMock).toHaveBeenCalledWith('voxpop', {
            expectedPdsHost: 'api.antiphony.dev',
            kv: pinCache,
        });
        expect(resolveProvidersMock).toHaveBeenCalledWith('voxpop');
        expect(audioProcessingServiceCtor).toHaveBeenCalledWith(
            hostedDeps,
            providers,
            expect.anything(),
            notifier,
        );
        expect(processMock).toHaveBeenCalledWith('voxpop', 'post-1');
    });

    it('classifies a declined lease (ran: false) as non-retryable', async () => {
        processMock.mockResolvedValueOnce(false);

        const result = await runProcessingJob({ originAppId: 'voxpop', postId: 'post-2' }, undefined);

        expect(result).toEqual({ outcome: 'ran', ran: false });
        expect(shouldRetry(result)).toBe(false);
    });

    it('classifies custody failure as threw (retryable) and does not invoke process()', async () => {
        const err = new Error('did:web unreachable');
        ensureTenantPinMock.mockRejectedValueOnce(err);

        const result = await runProcessingJob({ originAppId: 'voxpop', postId: 'post-3' }, undefined);

        expect(result).toEqual({ outcome: 'threw', err });
        expect(shouldRetry(result)).toBe(true);
        expect(processMock).not.toHaveBeenCalled();
    });

    it('classifies an exception escaping process() as threw (retryable)', async () => {
        const err = new Error('postgres timeout');
        processMock.mockRejectedValueOnce(err);

        const result = await runProcessingJob({ originAppId: 'voxpop', postId: 'post-4' }, undefined);

        expect(result).toEqual({ outcome: 'threw', err });
        expect(shouldRetry(result)).toBe(true);
    });

    it('skips custody pinning and wires remoteProcessingDeps for remoteUri jobs', async () => {
        processMock.mockResolvedValueOnce(true);
        const remoteUri = 'at://did:plc:abc/dev.antiphony.audio.post/rkey1';

        const result = await runProcessingJob(
            { originAppId: 'bardcast', remoteUri },
            undefined,
        );

        expect(result).toEqual({ outcome: 'ran', ran: true });
        expect(ensureTenantPinMock).not.toHaveBeenCalled();
        expect(resolveProvidersMock).toHaveBeenCalledWith('bardcast');
        expect(audioProcessingServiceCtor).toHaveBeenCalledWith(
            remoteDeps,
            providers,
            expect.anything(),
            notifier,
        );
        expect(processMock).toHaveBeenCalledWith('bardcast', remoteUri);
    });
});
