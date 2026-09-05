import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAudioPlayer } from './use-audio-player';

/**
 * jsdom builds HTMLAudioElement but leaves the media methods unimplemented —
 * `play()` throws "Not implemented", `duration` is NaN, and no media events
 * ever fire. So the element is stubbed wholesale with a fake that records
 * calls and lets the test drive events by hand.
 *
 * Driving events by hand is the point: the hook's whole job is translating
 * `loadedmetadata` / `timeupdate` / `ended` into React state, and a stub that
 * fired them automatically would test the stub.
 */

interface FakeAudio {
    src: string;
    currentTime: number;
    duration: number;
    paused: boolean;
    preload: string;
    crossOrigin: string | null;
    error: { message: string } | null;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    removeAttribute: ReturnType<typeof vi.fn>;
    addEventListener: (t: string, h: () => void) => void;
    removeEventListener: (t: string, h: () => void) => void;
    emit: (t: string) => void;
}

let audio: FakeAudio;

function makeFakeAudio(): FakeAudio {
    const listeners: Record<string, Array<() => void>> = {};
    const self: FakeAudio = {
        src: '',
        currentTime: 0,
        duration: NaN,
        paused: true,
        preload: '',
        crossOrigin: null,
        error: null,
        play: vi.fn(async () => {
            self.paused = false;
            self.emit('play');
        }),
        pause: vi.fn(() => {
            self.paused = true;
            self.emit('pause');
        }),
        load: vi.fn(),
        removeAttribute: vi.fn(),
        addEventListener: (t, h) => {
            (listeners[t] ??= []).push(h);
        },
        removeEventListener: (t, h) => {
            listeners[t] = (listeners[t] ?? []).filter((x) => x !== h);
        },
        emit: (t) => {
            for (const h of listeners[t] ?? []) h();
        },
    };
    return self;
}

beforeEach(() => {
    audio = makeFakeAudio();
    vi.stubGlobal('Audio', function Audio() {
        return audio;
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('useAudioPlayer', () => {
    it('loads the url and reports duration once metadata arrives', async () => {
        const { result } = renderHook(() => useAudioPlayer({ url: 'https://cdn.test/a.webm' }));

        expect(audio.src).toBe('https://cdn.test/a.webm');
        expect(result.current.status).toBe('loading');

        audio.duration = 12.5;
        act(() => audio.emit('loadedmetadata'));

        expect(result.current.status).toBe('paused');
        expect(result.current.durationMs).toBe(12500);
    });

    it('keeps the caller-supplied duration when the element reports Infinity', async () => {
        // A streamed source reads Infinity until fully buffered. Trusting it
        // would render "Infinity:NaN" and make progress NaN.
        const { result } = renderHook(() =>
            useAudioPlayer({ url: 'https://cdn.test/a.webm', durationMs: 8000 }),
        );

        audio.duration = Infinity;
        act(() => audio.emit('loadedmetadata'));

        expect(result.current.durationMs).toBe(8000);
    });

    it('toggles between play and pause', async () => {
        const { result } = renderHook(() => useAudioPlayer({ url: 'https://cdn.test/a.webm' }));

        await act(async () => result.current.toggle());
        await waitFor(() => expect(result.current.status).toBe('playing'));

        act(() => result.current.toggle());
        expect(audio.pause).toHaveBeenCalled();
        expect(result.current.status).toBe('paused');
    });

    it('surfaces a blocked autoplay as an error instead of an unhandled rejection', async () => {
        audio.play = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
        const { result } = renderHook(() => useAudioPlayer({ url: 'https://cdn.test/a.webm' }));

        await act(async () => {
            await result.current.play();
        });

        expect(result.current.status).toBe('error');
        expect(result.current.error).toBe('NotAllowedError');
    });

    it('reports progress from timeupdate, never NaN before duration is known', () => {
        const { result } = renderHook(() => useAudioPlayer({ url: 'https://cdn.test/a.webm' }));

        // Duration still unknown — progress must be 0, not 0/0.
        expect(result.current.progress).toBe(0);

        audio.duration = 10;
        act(() => audio.emit('loadedmetadata'));
        audio.currentTime = 2.5;
        act(() => audio.emit('timeupdate'));

        expect(result.current.currentTimeMs).toBe(2500);
        expect(result.current.progress).toBeCloseTo(0.25);
    });

    it('clamps a seek past the end and updates position immediately', () => {
        const { result } = renderHook(() => useAudioPlayer({ url: 'https://cdn.test/a.webm' }));
        audio.duration = 10;
        act(() => audio.emit('loadedmetadata'));

        act(() => result.current.seek(99_000));

        expect(audio.currentTime).toBe(10);
        // Set eagerly rather than waiting for the browser's throttled
        // `timeupdate`, or a scrubber lags the click that moved it.
        expect(result.current.currentTimeMs).toBe(10_000);
    });

    it('clamps a negative seek to zero', () => {
        const { result } = renderHook(() => useAudioPlayer({ url: 'https://cdn.test/a.webm' }));
        audio.duration = 10;
        act(() => audio.emit('loadedmetadata'));

        act(() => result.current.seek(-5000));

        expect(audio.currentTime).toBe(0);
    });

    it('seeks by fraction for waveform clicks', () => {
        const { result } = renderHook(() => useAudioPlayer({ url: 'https://cdn.test/a.webm' }));
        audio.duration = 20;
        act(() => audio.emit('loadedmetadata'));

        act(() => result.current.seekToProgress(0.5));

        expect(audio.currentTime).toBe(10);
    });

    it('marks ended and does not fall back to paused', () => {
        const { result } = renderHook(() => useAudioPlayer({ url: 'https://cdn.test/a.webm' }));

        act(() => audio.emit('ended'));
        expect(result.current.status).toBe('ended');

        // Browsers fire `pause` right after `ended`. Letting that overwrite the
        // status would make a finished clip indistinguishable from a paused one.
        act(() => audio.emit('pause'));
        expect(result.current.status).toBe('ended');
    });

    it('tears the source down on unmount so nothing keeps buffering', () => {
        const { unmount } = renderHook(() => useAudioPlayer({ url: 'https://cdn.test/a.webm' }));

        unmount();

        expect(audio.pause).toHaveBeenCalled();
        expect(audio.removeAttribute).toHaveBeenCalledWith('src');
        expect(audio.load).toHaveBeenCalled();
    });
});
