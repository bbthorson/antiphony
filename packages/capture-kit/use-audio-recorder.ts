import { useCallback, useEffect, useRef, useState } from 'react';

import { pickMimeType } from './mime';

/**
 * Headless browser audio-recorder hook: MediaRecorder wrapped in a small React
 * state machine that yields a `Recording` (blob + clean MIME + duration) ready
 * to hand to the upload step.
 *
 * **It renders nothing and styles nothing, on purpose.** Recording audio is a
 * fact about the bytes; what a record button looks like is a product judgement.
 * This hook owns the first and leaves the second entirely to the caller —
 * which is what lets an app with its own design language build on it without
 * inheriting anyone else's.
 *
 * It also does not upload. `stop()` produces a `Recording` and the hook is
 * finished; where those bytes go, under whose credentials, is app-layer
 * concern. Callers pass the blob to their own uploader.
 *
 * ## Surviving the page losing focus
 *
 * A take outlives the user's attention more often than a demo suggests: a
 * phone's screen auto-locks partway through a reply, a tab gets switched, a
 * call comes in, a Bluetooth headset drops. The hook handles each of those
 * itself rather than leaving every consumer to rediscover them:
 *
 * - **Screen wake lock** (`wakeLock`, on by default) keeps a phone from
 *   auto-locking mid-take, and is taken again when the page comes back.
 * - **Interruptions end the take honestly.** When the input track ends or
 *   mutes, or MediaRecorder errors, the hook stops and returns what it has,
 *   tagged with `recording.interruption` — rather than a take that silently
 *   finished on its own, or one that carries on recording silence.
 * - **`maxDurationMs` does not depend on timers alone.** Browsers throttle
 *   timers in hidden tabs, so the cap is also checked on every MediaRecorder
 *   chunk and whenever the page becomes visible again.
 *
 * What the hook cannot do is keep a microphone open where the browser will
 * not: WebKit (every iOS browser) cuts capture when the page is backgrounded or
 * the screen locks. The hook's job there is to notice and say so.
 */

export interface Recording {
    blob: Blob;
    /** MIME without codec suffix (e.g. `audio/webm`), matching the upload allowlist. */
    mimeType: string;
    /**
     * Wall-clock length of the take. For an interrupted take this is measured
     * to the moment of the interruption (or to when the page was hidden, if it
     * was hidden at the time), so it can be shorter than the audio in `blob`
     * when a browser kept writing silence after the input muted.
     */
    durationMs: number;
    /** Object URL for local preview; revoke on reset. */
    previewUrl: string;
    /**
     * Why the take ended without the caller's `stop()` or the `maxDurationMs`
     * cap, or `null` when it ended normally. The audio up to that point is
     * still in `blob`; whether to offer it, or ask for another take, is the
     * caller's product judgement.
     */
    interruption: RecorderInterruption | null;
}

export type RecorderStatus = 'idle' | 'recording' | 'recorded' | 'error';

/**
 * What cut a take short. Like `RecorderErrorKind`, a classification and not
 * copy — the consumer decides how to say it.
 */
export type RecorderInterruption =
    /**
     * The input track ended: the device was unplugged, permission was
     * revoked, or the OS took the microphone away for good.
     */
    | 'device-lost'
    /**
     * The input track muted: the page was backgrounded or the screen locked on
     * a browser that will not capture in the background (every iOS browser),
     * a phone call took the microphone, or the OS mic switch was flipped.
     * Anything recorded after this point would be silence.
     */
    | 'muted'
    /** MediaRecorder raised an `error` event mid-take. */
    | 'recorder-error';

/**
 * Why the microphone could not be opened.
 *
 * The kit classifies; the consumer writes the copy. "Permission was denied" is
 * a fact about the browser, but *how you say that to a user* — and whether you
 * link them to their settings — is a product judgement, and one that reads
 * differently in a dashboard than in an iframe on someone else's site.
 *
 * Exposed as a discriminant so consumers can branch on it rather than matching
 * substrings of `error`, which is the alternative and breaks per browser and
 * per locale.
 */
export type RecorderErrorKind =
    /** The user (or a permissions policy) refused the microphone. */
    | 'permission-denied'
    /** No input device exists. */
    | 'no-device'
    /** MediaRecorder or getUserMedia is missing — an insecure origin, usually. */
    | 'unsupported'
    /**
     * The take was interrupted (see `RecorderInterruption`) before any audio
     * was captured, so there is no `Recording` to hand back.
     */
    | 'interrupted'
    | 'unknown';

/** Map a `getUserMedia` rejection onto a `RecorderErrorKind`. */
function classifyError(e: unknown): RecorderErrorKind {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return 'unsupported';
    if (e instanceof DOMException) {
        // `SecurityError` is what a permissions-policy block raises, which from
        // the caller's side is indistinguishable from a user saying no.
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError') return 'permission-denied';
        if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') return 'no-device';
        if (e.name === 'NotSupportedError') return 'unsupported';
    }
    return 'unknown';
}

/** The page's Screen Wake Lock, or `undefined` where the browser has none. */
function screenWakeLock(): WakeLock | undefined {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return undefined;
    return navigator.wakeLock;
}

function pageIsVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState === 'visible';
}

export interface UseAudioRecorderOptions {
    /**
     * Stop automatically after this many milliseconds.
     *
     * Every consumer has an upload ceiling, and without this each one
     * reimplements the same timer to enforce it. Omit for no limit.
     *
     * Checked on the `tickMs` interval, on every MediaRecorder chunk
     * (`timesliceMs`), and when the page becomes visible again — so a take in
     * a throttled background tab overshoots by about one chunk, not by however
     * long the browser chose to sleep the timer.
     */
    maxDurationMs?: number;
    /**
     * How often `elapsedMs` updates while recording, in milliseconds.
     * Default 100 — fast enough for a smooth counter, slow enough not to
     * re-render a caller's tree 60 times a second.
     */
    tickMs?: number;
    /**
     * How often MediaRecorder hands over a chunk of encoded audio, in
     * milliseconds. Default 1000.
     *
     * Chunk events are not throttled the way timers are in a hidden tab, which
     * is what lets `maxDurationMs` hold there. The chunks are concatenated into
     * one `Blob` on stop either way.
     */
    timesliceMs?: number;
    /**
     * Expose a live `AnalyserNode` over the input stream, for drawing a
     * reactive visualization while recording.
     *
     * **Opt-in, because it is not free**: it opens an AudioContext for the
     * duration of the take, and a consumer that only wants the resulting blob
     * should not pay for one. Browsers also cap AudioContexts per page.
     *
     * What you *draw* with the frequency data is entirely yours — the kit
     * hands you the node and nothing else.
     */
    analyser?: boolean;
    /**
     * `fftSize` for that analyser. Default 256, which gives 128 frequency bins
     * — enough resolution for an amplitude visualization without the per-frame
     * cost of a larger transform.
     */
    fftSize?: number;
    /**
     * Hold a Screen Wake Lock while recording, so a phone does not auto-lock
     * partway through a take. Default `true`.
     *
     * Best-effort: where the API is missing, or the browser refuses (a
     * permissions policy, battery saver), recording goes ahead without it.
     * The browser drops the lock whenever the page is hidden; the hook takes
     * it again when the page is visible and the take is still running.
     */
    wakeLock?: boolean;
}

export function useAudioRecorder(options: UseAudioRecorderOptions = {}) {
    const {
        maxDurationMs,
        tickMs = 100,
        timesliceMs = 1000,
        analyser: wantAnalyser = false,
        fftSize = 256,
        wakeLock: wantWakeLock = true,
    } = options;

    const [status, setStatus] = useState<RecorderStatus>('idle');
    const [recording, setRecording] = useState<Recording | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [errorKind, setErrorKind] = useState<RecorderErrorKind | null>(null);
    /**
     * Live analyser over the input stream while recording, or `null`. Only
     * ever non-null when the `analyser` option is on and a take is running.
     */
    const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
    /**
     * Milliseconds recorded so far. Distinct from `recording.durationMs`, which
     * only exists once recording has STOPPED — a caller rendering a live
     * counter needs a value during the take, and without one here every
     * consumer runs its own parallel timer against the same clock.
     */
    const [elapsedMs, setElapsedMs] = useState(0);

    /**
     * The running recorder, or `null`. Cleared by whoever *decides* the take
     * ends (`stop()`, the cap, an interruption) before MediaRecorder's own
     * asynchronous `onstop` fires — so `onstop` finding it still set means
     * nobody here decided, and the browser stopped the recorder by itself.
     */
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const startedAtRef = useRef<number>(0);
    /** When the take ended, if something other than `onstop` knows better. */
    const endedAtRef = useRef<number | null>(null);
    const interruptionRef = useRef<RecorderInterruption | null>(null);
    /** When the page was last hidden during this take, or `null` while visible. */
    const hiddenAtRef = useRef<number | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const wakeLockRef = useRef<WakeLockSentinel | null>(null);
    /** Removes the track and document listeners a take attached. */
    const detachRef = useRef<(() => void) | null>(null);
    /**
     * The cap, read from listeners attached at `start()` time. A ref so a
     * caller changing `maxDurationMs` mid-take is honoured rather than
     * captured stale by the closure.
     */
    const maxDurationRef = useRef(maxDurationMs);
    useEffect(() => {
        maxDurationRef.current = maxDurationMs;
    }, [maxDurationMs]);

    const releaseWakeLock = useCallback(() => {
        const sentinel = wakeLockRef.current;
        wakeLockRef.current = null;
        if (sentinel) void sentinel.release().catch(() => {});
    }, []);

    const acquireWakeLock = useCallback(async () => {
        const api = screenWakeLock();
        if (!wantWakeLock || !api || wakeLockRef.current || !pageIsVisible()) return;
        try {
            const sentinel = await api.request('screen');
            // The take may have ended while the request was pending.
            if (!recorderRef.current) {
                void sentinel.release().catch(() => {});
                return;
            }
            wakeLockRef.current = sentinel;
            // The browser releases it on its own when the page is hidden; drop
            // the reference so the visibility handler knows to ask again.
            sentinel.addEventListener('release', () => {
                if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
            });
        } catch {
            // Refused (permissions policy, battery saver, page hidden in the
            // meantime). The lock is a nicety; the take goes on without it.
        }
    }, [wantWakeLock]);

    /**
     * Release everything a take acquired: the input stream, the analyser's
     * AudioContext, the wake lock and the listeners. They are acquired
     * together, so tearing them down separately is how one leaks: an
     * AudioContext left open holds the audio hardware awake, and browsers cap
     * how many a page may have.
     */
    const stopTracks = useCallback(() => {
        detachRef.current?.();
        detachRef.current = null;
        releaseWakeLock();
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (audioContextRef.current) {
            void audioContextRef.current.close();
            audioContextRef.current = null;
        }
        setAnalyser(null);
    }, [releaseWakeLock]);

    /**
     * End the take. `interruption` and `endedAt` are for the hook's own
     * callers; the public `stop()` passes neither.
     *
     * Clears `recorderRef` *before* calling `stop()` on it — see the note on
     * the ref — and is a no-op once a take is already ending, so the cap, an
     * interruption and the user's own tap can race without double-stopping.
     */
    const finish = useCallback(
        (interruption: RecorderInterruption | null = null, endedAt: number = Date.now()) => {
            const recorder = recorderRef.current;
            if (!recorder) return;
            recorderRef.current = null;
            interruptionRef.current = interruption;
            endedAtRef.current = endedAt;
            // The browser may already have stopped it (a track ending stops
            // the recorder by itself); `onstop` fires regardless.
            if (recorder.state !== 'inactive') recorder.stop();
        },
        [],
    );

    const stop = useCallback(() => finish(), [finish]);

    /** Enforce `maxDurationMs` against the wall clock. Safe to call often. */
    const checkCap = useCallback(() => {
        const max = maxDurationRef.current;
        if (max !== undefined && Date.now() - startedAtRef.current >= max) finish();
    }, [finish]);

    /**
     * Release the microphone if the caller unmounts mid-take.
     *
     * Without this the MediaStream tracks stay live after the component is
     * gone: the browser's recording indicator stays lit and the mic stays open
     * with nothing listening. Runs on unmount only — `stopTracks` is stable, so
     * this does not re-fire on re-render.
     */
    useEffect(() => stopTracks, [stopTracks]);

    /**
     * The elapsed-time ticker, and the `maxDurationMs` enforcement that rides
     * on it. One interval serves both so the cap can never disagree with the
     * counter the user is watching. (The cap has two more triggers that do not
     * depend on timers — see `checkCap`'s callers in `start`.)
     */
    useEffect(() => {
        if (status !== 'recording') return;

        const id = setInterval(() => {
            setElapsedMs(Date.now() - startedAtRef.current);
            checkCap();
        }, tickMs);

        return () => clearInterval(id);
    }, [status, tickMs, checkCap]);

    const start = useCallback(async () => {
        setError(null);
        setErrorKind(null);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            const mimeType = pickMimeType();
            const recorder = new MediaRecorder(stream, { mimeType });
            chunksRef.current = [];
            interruptionRef.current = null;
            endedAtRef.current = null;
            hiddenAtRef.current = null;

            if (wantAnalyser) {
                const AudioCtx: typeof AudioContext =
                    window.AudioContext ??
                    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
                const audioContext = new AudioCtx();
                audioContextRef.current = audioContext;
                const node = audioContext.createAnalyser();
                node.fftSize = fftSize;
                // Source → analyser, and deliberately NOT on to `destination`:
                // routing the mic to the speakers is an instant feedback loop.
                audioContext.createMediaStreamSource(stream).connect(node);
                setAnalyser(node);
            }

            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunksRef.current.push(e.data);
                // A chunk arrives every `timesliceMs` even in a hidden tab,
                // where the interval above may be asleep.
                if (recorderRef.current === recorder) checkCap();
            };
            recorder.onerror = () => {
                if (recorderRef.current === recorder) finish('recorder-error');
            };
            recorder.onstop = () => {
                // Nobody here ended the take, so the browser did — which it
                // does when every input track has ended.
                if (recorderRef.current === recorder) {
                    recorderRef.current = null;
                    interruptionRef.current = 'device-lost';
                }
                const interruption = interruptionRef.current;
                const endedAt = endedAtRef.current ?? Date.now();
                const cleanType = mimeType.split(';')[0];
                const blob = new Blob(chunksRef.current, { type: cleanType });
                const durationMs = Math.max(0, endedAt - startedAtRef.current);
                stopTracks();
                setElapsedMs(durationMs);

                if (interruption && blob.size === 0) {
                    // Nothing was captured before the interruption, so there is
                    // no take to offer — report it as a failed start instead.
                    setError(`Recording was interrupted (${interruption}) before any audio was captured`);
                    setErrorKind('interrupted');
                    setStatus('error');
                    return;
                }

                setRecording({
                    blob,
                    mimeType: cleanType,
                    durationMs,
                    previewUrl: URL.createObjectURL(blob),
                    interruption,
                });
                setStatus('recorded');
            };

            /**
             * When the take was really over, for an interruption we may only
             * hear about late. A browser that suspends a backgrounded page
             * (WebKit) delivers the track's `mute` as the page comes back, so
             * "now" would count the whole time away; the moment the page was
             * hidden is the better answer. An event that arrives while the page
             * is *still* hidden was delivered live — capture kept running in
             * the background (desktop, Android) — so "now" is right there.
             */
            const interruptedAt = () =>
                pageIsVisible() && hiddenAtRef.current !== null ? hiddenAtRef.current : Date.now();

            const onTrackEnded = () => finish('device-lost', interruptedAt());
            const onTrackMuted = () => finish('muted', interruptedAt());
            const onVisibilityChange = () => {
                if (recorderRef.current !== recorder) return;
                if (!pageIsVisible()) {
                    hiddenAtRef.current = Date.now();
                    return;
                }
                // Back in view. If the input went silent or away while the page
                // was hidden and the event has not arrived (or never will),
                // catch it here.
                const tracks = stream.getAudioTracks();
                if (tracks.some((t) => t.readyState === 'ended')) {
                    finish('device-lost', interruptedAt());
                    return;
                }
                if (tracks.some((t) => t.muted)) {
                    finish('muted', interruptedAt());
                    return;
                }
                hiddenAtRef.current = null;
                setElapsedMs(Date.now() - startedAtRef.current);
                checkCap();
                // The browser released the wake lock when the page hid.
                if (recorderRef.current === recorder) void acquireWakeLock();
            };

            const tracks = stream.getAudioTracks();
            for (const track of tracks) {
                track.addEventListener('ended', onTrackEnded);
                track.addEventListener('mute', onTrackMuted);
            }
            document.addEventListener('visibilitychange', onVisibilityChange);
            detachRef.current = () => {
                for (const track of tracks) {
                    track.removeEventListener('ended', onTrackEnded);
                    track.removeEventListener('mute', onTrackMuted);
                }
                document.removeEventListener('visibilitychange', onVisibilityChange);
            };

            startedAtRef.current = Date.now();
            setElapsedMs(0);
            recorder.start(timesliceMs);
            recorderRef.current = recorder;
            setStatus('recording');
            void acquireWakeLock();
        } catch (e) {
            stopTracks();
            setError(e instanceof Error ? e.message : 'Could not access microphone');
            setErrorKind(classifyError(e));
            setStatus('error');
        }
    }, [stopTracks, finish, checkCap, acquireWakeLock, wantAnalyser, fftSize, timesliceMs]);

    const reset = useCallback(() => {
        if (recording) URL.revokeObjectURL(recording.previewUrl);
        setRecording(null);
        setError(null);
        setErrorKind(null);
        setElapsedMs(0);
        setStatus('idle');
    }, [recording]);

    return { status, recording, error, errorKind, elapsedMs, analyser, start, stop, reset };
}
