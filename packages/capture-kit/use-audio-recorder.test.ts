import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAudioRecorder } from './use-audio-recorder';

/**
 * jsdom implements neither MediaRecorder nor getUserMedia, so both are stubbed.
 * The stubs are faithful about the one thing the hook depends on: `stop()` is
 * asynchronous in the real API — it fires `onstop` later, and the `Recording`
 * only exists at that point. A stub that produced the blob synchronously would
 * pass while the real hook deadlocked.
 */

const stopTrack = vi.fn();
/** Spied separately from the instance so the assertions never need to reach
 *  into the fake — `no-this-alias` forbids stashing the instance itself. */
const recorderStopped = vi.fn();

class FakeMediaRecorder {
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    state = 'inactive';

    constructor(_stream: MediaStream, readonly options: { mimeType: string }) {}
    static isTypeSupported(type: string) {
        return type === 'audio/webm;codecs=opus';
    }
    start() {
        this.state = 'recording';
    }
    stop() {
        this.state = 'inactive';
        recorderStopped();
        this.ondataavailable?.({ data: new Blob(['chunk'], { type: 'audio/webm' }) });
        this.onstop?.();
    }
}

function stubMediaStack({ deny = false } = {}) {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('navigator', {
        mediaDevices: {
            getUserMedia: deny
                ? vi.fn().mockRejectedValue(new Error('Permission denied'))
                : vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
        },
    });
}

beforeEach(() => {
    vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: vi.fn(() => 'blob:fake-preview'),
        revokeObjectURL: vi.fn(),
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe('useAudioRecorder', () => {
    it('walks idle → recording → recorded and yields a Recording', async () => {
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        expect(result.current.status).toBe('idle');

        await act(async () => {
            await result.current.start();
        });
        expect(result.current.status).toBe('recording');

        act(() => result.current.stop());

        await waitFor(() => expect(result.current.status).toBe('recorded'));
        expect(result.current.recording).toMatchObject({
            // The codec suffix is stripped: the upload allowlist matches on the
            // bare type, so `audio/webm;codecs=opus` would fail it.
            mimeType: 'audio/webm',
            previewUrl: 'blob:fake-preview',
        });
        expect(result.current.recording?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('releases the microphone when recording stops', async () => {
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        act(() => result.current.stop());

        await waitFor(() => expect(stopTrack).toHaveBeenCalled());
    });

    it('releases the microphone if the caller unmounts mid-take', async () => {
        stubMediaStack();
        const { result, unmount } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        expect(stopTrack).not.toHaveBeenCalled();

        unmount();

        // Without the unmount cleanup the browser's recording indicator stays
        // lit after the component is gone, with nothing listening.
        expect(stopTrack).toHaveBeenCalled();
    });

    it('reports a denied microphone as an error rather than throwing', async () => {
        stubMediaStack({ deny: true });
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });

        expect(result.current.status).toBe('error');
        expect(result.current.error).toBe('Permission denied');
        expect(result.current.recording).toBeNull();
    });

    it('revokes the preview object URL on reset', async () => {
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        act(() => result.current.stop());
        await waitFor(() => expect(result.current.recording).not.toBeNull());

        act(() => result.current.reset());

        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-preview');
        expect(result.current.status).toBe('idle');
        expect(result.current.recording).toBeNull();
    });

    it('stops itself at maxDurationMs', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder({ maxDurationMs: 500, tickMs: 50 }));

        await act(async () => {
            await result.current.start();
        });
        expect(result.current.status).toBe('recording');

        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });

        expect(result.current.status).toBe('recorded');
        expect(recorderStopped).toHaveBeenCalled();
    });

    it('tracks elapsedMs while recording', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder({ tickMs: 50 }));

        await act(async () => {
            await result.current.start();
        });
        expect(result.current.elapsedMs).toBe(0);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
        });

        // The live counter a caller renders during the take — without it every
        // consumer runs a second timer against the same clock.
        expect(result.current.elapsedMs).toBeGreaterThan(0);
    });
});
