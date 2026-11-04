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
const recorderStarted = vi.fn();
/** Every recorder constructed, for tests that drive one from outside. */
const recorders: FakeMediaRecorder[] = [];

class FakeMediaRecorder {
    /** Off to simulate a take interrupted before any audio was encoded. */
    static emitOnStop = true;

    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    state = 'inactive';

    constructor(_stream: MediaStream, readonly options: { mimeType: string }) {
        recorders.push(this);
    }
    static isTypeSupported(type: string) {
        return type === 'audio/webm;codecs=opus';
    }
    start(timeslice?: number) {
        this.state = 'recording';
        recorderStarted(timeslice);
    }
    stop() {
        this.state = 'inactive';
        recorderStopped();
        if (FakeMediaRecorder.emitOnStop) this.chunk();
        this.onstop?.();
    }
    /** A timeslice chunk, as the real recorder emits every `timeslice` ms. */
    chunk() {
        this.ondataavailable?.({ data: new Blob(['chunk'], { type: 'audio/webm' }) });
    }
    /** What the browser does when every input track ends: stop by itself. */
    stopBySelf() {
        this.state = 'inactive';
        if (FakeMediaRecorder.emitOnStop) this.chunk();
        this.onstop?.();
    }
}

/** An input track with real event dispatch, so `mute` / `ended` can fire. */
class FakeTrack extends EventTarget {
    kind = 'audio';
    muted = false;
    readyState: 'live' | 'ended' = 'live';
    stop = stopTrack;
}
let track: FakeTrack;

const recorder = () => recorders[recorders.length - 1];

/** Screen Wake Lock stub: a sentinel that dispatches `release` like the real one. */
class FakeSentinel extends EventTarget {
    released = false;
    release = vi.fn(async () => {
        this.released = true;
        this.dispatchEvent(new Event('release'));
    });
}
const sentinels: FakeSentinel[] = [];
const wakeLockRequest = vi.fn(async () => {
    const s = new FakeSentinel();
    sentinels.push(s);
    return s;
});

let visibility: DocumentVisibilityState = 'visible';
/** Flip the page's visibility and fire the event, as switching tabs does. */
function setVisibility(next: DocumentVisibilityState) {
    visibility = next;
    document.dispatchEvent(new Event('visibilitychange'));
}

const analyserNode = { fftSize: 0 } as unknown as AnalyserNode;
const audioContextClose = vi.fn();
const connect = vi.fn();

/** Minimal Web Audio stub — jsdom has none. */
function stubAudioContext() {
    class FakeAudioContext {
        close = audioContextClose;
        createAnalyser = () => analyserNode;
        createMediaStreamSource = () => ({ connect });
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
}

function stubMediaStack({ deny = false, wakeLock = true } = {}) {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('navigator', {
        mediaDevices: {
            getUserMedia: deny
                ? vi.fn().mockRejectedValue(new Error('Permission denied'))
                : vi.fn().mockResolvedValue({
                      getTracks: () => [track],
                      getAudioTracks: () => [track],
                  }),
        },
        ...(wakeLock ? { wakeLock: { request: wakeLockRequest } } : {}),
    });
}

beforeEach(() => {
    track = new FakeTrack();
    recorders.length = 0;
    sentinels.length = 0;
    FakeMediaRecorder.emitOnStop = true;
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: vi.fn(() => 'blob:fake-preview'),
        revokeObjectURL: vi.fn(),
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
            // The caller ended it: nothing to explain to the user.
            interruption: null,
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

describe('useAudioRecorder — error classification', () => {
    it('reports a refused microphone as permission-denied', async () => {
        vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
        vi.stubGlobal('navigator', {
            mediaDevices: {
                getUserMedia: vi
                    .fn()
                    .mockRejectedValue(new DOMException('Denied', 'NotAllowedError')),
            },
        });
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });

        // The discriminant, so a consumer writes its own copy instead of
        // matching substrings of a browser- and locale-specific message.
        expect(result.current.errorKind).toBe('permission-denied');
    });

    it('reports a permissions-policy block as permission-denied too', async () => {
        // An iframe without `allow="microphone"` raises SecurityError, which
        // from the caller's side is the same situation as a user saying no.
        vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
        vi.stubGlobal('navigator', {
            mediaDevices: {
                getUserMedia: vi
                    .fn()
                    .mockRejectedValue(new DOMException('Blocked', 'SecurityError')),
            },
        });
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });

        expect(result.current.errorKind).toBe('permission-denied');
    });

    it('reports a missing microphone as no-device', async () => {
        vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
        vi.stubGlobal('navigator', {
            mediaDevices: {
                getUserMedia: vi
                    .fn()
                    .mockRejectedValue(new DOMException('None', 'NotFoundError')),
            },
        });
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });

        expect(result.current.errorKind).toBe('no-device');
    });

    it('reports an absent mediaDevices as unsupported', async () => {
        vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
        vi.stubGlobal('navigator', {});
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });

        // An insecure origin, typically — `navigator.mediaDevices` is simply
        // not there, so the call throws a TypeError rather than a DOMException.
        expect(result.current.errorKind).toBe('unsupported');
    });

    it('clears the error kind on reset', async () => {
        stubMediaStack({ deny: true });
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        expect(result.current.errorKind).not.toBeNull();

        act(() => result.current.reset());
        expect(result.current.errorKind).toBeNull();
    });
});

describe('useAudioRecorder — analyser', () => {
    it('is null unless asked for', async () => {
        stubMediaStack();
        stubAudioContext();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });

        // Opt-in: an AudioContext is a capped, hardware-holding resource, and a
        // caller that only wants the blob should not open one.
        expect(result.current.analyser).toBeNull();
    });

    it('exposes a live analyser while recording when opted in', async () => {
        stubMediaStack();
        stubAudioContext();
        const { result } = renderHook(() => useAudioRecorder({ analyser: true, fftSize: 512 }));

        await act(async () => {
            await result.current.start();
        });

        expect(result.current.analyser).toBe(analyserNode);
        expect(analyserNode.fftSize).toBe(512);
        // Source → analyser, and never on to `destination`: routing the mic to
        // the speakers is an instant feedback loop.
        expect(connect).toHaveBeenCalledWith(analyserNode);
    });

    it('closes the AudioContext and drops the analyser when the take ends', async () => {
        stubMediaStack();
        stubAudioContext();
        const { result } = renderHook(() => useAudioRecorder({ analyser: true }));

        await act(async () => {
            await result.current.start();
        });
        act(() => result.current.stop());

        await waitFor(() => expect(result.current.analyser).toBeNull());
        expect(audioContextClose).toHaveBeenCalled();
    });

    it('closes the AudioContext if the caller unmounts mid-take', async () => {
        stubMediaStack();
        stubAudioContext();
        const { result, unmount } = renderHook(() => useAudioRecorder({ analyser: true }));

        await act(async () => {
            await result.current.start();
        });
        unmount();

        expect(audioContextClose).toHaveBeenCalled();
    });
});

describe('useAudioRecorder — chunking', () => {
    it('asks MediaRecorder for timeslice chunks, 1 s by default', async () => {
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });

        // Chunk events are what keep the cap honest in a throttled tab.
        expect(recorderStarted).toHaveBeenCalledWith(1000);
    });

    it('concatenates every chunk into the one Recording', async () => {
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        act(() => {
            recorder().chunk();
            recorder().chunk();
        });
        act(() => result.current.stop());

        await waitFor(() => expect(result.current.status).toBe('recorded'));
        // Two timeslice chunks plus the flush on stop, five bytes each.
        expect(result.current.recording?.blob.size).toBe(15);
    });
});

describe('useAudioRecorder — maxDurationMs without timers', () => {
    it('enforces the cap on a chunk even when the interval never ticks', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder({ maxDurationMs: 500, tickMs: 60_000 }));

        await act(async () => {
            await result.current.start();
        });
        // The wall clock moves on but no timer fires — a hidden tab whose
        // interval the browser has put to sleep.
        vi.setSystemTime(Date.now() + 600);
        act(() => recorder().chunk());

        expect(result.current.status).toBe('recorded');
        expect(recorderStopped).toHaveBeenCalled();
    });

    it('enforces the cap when the page becomes visible again', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder({ maxDurationMs: 500, tickMs: 60_000 }));

        await act(async () => {
            await result.current.start();
        });
        act(() => setVisibility('hidden'));
        vi.setSystemTime(Date.now() + 600);
        act(() => setVisibility('visible'));

        expect(result.current.status).toBe('recorded');
        // Hitting the cap is a normal end, not an interruption.
        expect(result.current.recording?.interruption).toBeNull();
    });
});

describe('useAudioRecorder — interruptions', () => {
    it('stops and tags the take when the input track mutes', async () => {
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        act(() => {
            track.muted = true;
            track.dispatchEvent(new Event('mute'));
        });

        await waitFor(() => expect(result.current.status).toBe('recorded'));
        // What was captured before the mute is kept; everything after would
        // have been silence.
        expect(result.current.recording?.interruption).toBe('muted');
        expect(result.current.recording?.blob.size).toBeGreaterThan(0);
        expect(stopTrack).toHaveBeenCalled();
    });

    it('stops and tags the take when the input track ends', async () => {
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        act(() => {
            track.readyState = 'ended';
            track.dispatchEvent(new Event('ended'));
        });

        await waitFor(() => expect(result.current.status).toBe('recorded'));
        expect(result.current.recording?.interruption).toBe('device-lost');
    });

    it('treats a recorder that stopped by itself as device-lost', async () => {
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        // No `ended` event reached us — only the recorder's own stop.
        act(() => recorder().stopBySelf());

        await waitFor(() => expect(result.current.status).toBe('recorded'));
        // Before: a take the user never ended surfaced as a normal Recording.
        expect(result.current.recording?.interruption).toBe('device-lost');
    });

    it('stops and tags the take on a MediaRecorder error', async () => {
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        act(() => recorder().onerror?.());

        await waitFor(() => expect(result.current.status).toBe('recorded'));
        expect(result.current.recording?.interruption).toBe('recorder-error');
    });

    it('reports an interruption with no audio as an error, not an empty take', async () => {
        FakeMediaRecorder.emitOnStop = false;
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        act(() => track.dispatchEvent(new Event('mute')));

        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(result.current.errorKind).toBe('interrupted');
        expect(result.current.recording).toBeNull();
    });

    it('catches a mute that happened while hidden when the page comes back', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        vi.setSystemTime(Date.now() + 2_000);
        act(() => setVisibility('hidden'));
        // WebKit mutes capture while backgrounded and the page is suspended,
        // so the event may never be seen live — only the muted track is.
        track.muted = true;
        vi.setSystemTime(Date.now() + 60_000);
        act(() => setVisibility('visible'));

        expect(result.current.status).toBe('recorded');
        expect(result.current.recording?.interruption).toBe('muted');
        // Measured to when the page was hidden, not across the minute away.
        expect(result.current.recording?.durationMs).toBe(2_000);
    });

    it('uses the time of a mute delivered live while the page is hidden', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        vi.setSystemTime(Date.now() + 2_000);
        act(() => setVisibility('hidden'));
        // A desktop tab keeps capturing in the background, so a mute arriving
        // now (a call, the OS mic switch) really did happen now.
        vi.setSystemTime(Date.now() + 5_000);
        act(() => track.dispatchEvent(new Event('mute')));

        expect(result.current.status).toBe('recorded');
        expect(result.current.recording?.durationMs).toBe(7_000);
    });

    it('does not double-stop when the user stops and the track ends together', async () => {
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        act(() => {
            result.current.stop();
            track.dispatchEvent(new Event('ended'));
        });

        await waitFor(() => expect(result.current.status).toBe('recorded'));
        expect(recorderStopped).toHaveBeenCalledTimes(1);
        // The user's stop came first; the take is theirs, not an interruption.
        expect(result.current.recording?.interruption).toBeNull();
    });
});

describe('useAudioRecorder — screen wake lock', () => {
    it('holds a screen wake lock while recording and releases it on stop', async () => {
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        await waitFor(() => expect(wakeLockRequest).toHaveBeenCalledWith('screen'));

        act(() => result.current.stop());

        await waitFor(() => expect(sentinels[0].released).toBe(true));
    });

    it('takes the lock again when the page comes back mid-take', async () => {
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        await waitFor(() => expect(sentinels).toHaveLength(1));

        // The browser drops the lock on its own when the page hides.
        await act(async () => {
            setVisibility('hidden');
            await sentinels[0].release();
        });
        await act(async () => {
            setVisibility('visible');
        });

        await waitFor(() => expect(wakeLockRequest).toHaveBeenCalledTimes(2));
        expect(result.current.status).toBe('recording');
    });

    it('releases the lock if the caller unmounts mid-take', async () => {
        stubMediaStack();
        const { result, unmount } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });
        await waitFor(() => expect(sentinels).toHaveLength(1));
        unmount();

        expect(sentinels[0].release).toHaveBeenCalled();
    });

    it('does not ask for one when wakeLock is off', async () => {
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder({ wakeLock: false }));

        await act(async () => {
            await result.current.start();
        });

        expect(wakeLockRequest).not.toHaveBeenCalled();
    });

    it('records without one where the browser has no Wake Lock API', async () => {
        stubMediaStack({ wakeLock: false });
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });

        expect(result.current.status).toBe('recording');
    });

    it('records without one when the browser refuses it', async () => {
        wakeLockRequest.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
        stubMediaStack();
        const { result } = renderHook(() => useAudioRecorder());

        await act(async () => {
            await result.current.start();
        });

        // The lock is a nicety; a refusal never becomes a recorder error.
        expect(result.current.status).toBe('recording');
        expect(result.current.errorKind).toBeNull();
    });
});
