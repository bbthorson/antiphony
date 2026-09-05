import { useCallback, useEffect, useRef, useState } from 'react';

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
 */

export interface Recording {
    blob: Blob;
    /** MIME without codec suffix (e.g. `audio/webm`), matching the upload allowlist. */
    mimeType: string;
    durationMs: number;
    /** Object URL for local preview; revoke on reset. */
    previewUrl: string;
}

export type RecorderStatus = 'idle' | 'recording' | 'recorded' | 'error';

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

export interface UseAudioRecorderOptions {
    /**
     * Stop automatically after this many milliseconds.
     *
     * Every consumer has an upload ceiling, and without this each one
     * reimplements the same timer to enforce it. Omit for no limit.
     */
    maxDurationMs?: number;
    /**
     * How often `elapsedMs` updates while recording, in milliseconds.
     * Default 100 — fast enough for a smooth counter, slow enough not to
     * re-render a caller's tree 60 times a second.
     */
    tickMs?: number;
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
}

/**
 * Pick the first MediaRecorder MIME the browser supports from our allowlist.
 *
 * Exported because it is the answer to "what will this browser actually give
 * me?", which a caller may need *before* recording — to warn on an
 * unsupported browser, or to check the result against a server-side allowlist.
 */
export function pickMimeType(): string {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
    for (const c of candidates) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
    }
    return 'audio/webm';
}

export function useAudioRecorder(options: UseAudioRecorderOptions = {}) {
    const { maxDurationMs, tickMs = 100, analyser: wantAnalyser = false, fftSize = 256 } = options;

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

    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const startedAtRef = useRef<number>(0);
    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);

    /**
     * Release the input stream and the analyser's AudioContext together. They
     * are acquired together, so tearing them down separately is how one leaks:
     * an AudioContext left open holds the audio hardware awake, and browsers
     * cap how many a page may have.
     */
    const stopTracks = useCallback(() => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (audioContextRef.current) {
            void audioContextRef.current.close();
            audioContextRef.current = null;
        }
        setAnalyser(null);
    }, []);

    const stop = useCallback(() => {
        recorderRef.current?.stop();
        recorderRef.current = null;
    }, []);

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
     * counter the user is watching.
     */
    useEffect(() => {
        if (status !== 'recording') return;

        const id = setInterval(() => {
            const elapsed = Date.now() - startedAtRef.current;
            setElapsedMs(elapsed);
            if (maxDurationMs !== undefined && elapsed >= maxDurationMs) stop();
        }, tickMs);

        return () => clearInterval(id);
    }, [status, maxDurationMs, tickMs, stop]);

    const start = useCallback(async () => {
        setError(null);
        setErrorKind(null);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            const mimeType = pickMimeType();
            const recorder = new MediaRecorder(stream, { mimeType });
            chunksRef.current = [];

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
            };
            recorder.onstop = () => {
                const cleanType = mimeType.split(';')[0];
                const blob = new Blob(chunksRef.current, { type: cleanType });
                const durationMs = Date.now() - startedAtRef.current;
                stopTracks();
                setRecording({
                    blob,
                    mimeType: cleanType,
                    durationMs,
                    previewUrl: URL.createObjectURL(blob),
                });
                setElapsedMs(durationMs);
                setStatus('recorded');
            };

            startedAtRef.current = Date.now();
            setElapsedMs(0);
            recorder.start();
            recorderRef.current = recorder;
            setStatus('recording');
        } catch (e) {
            stopTracks();
            setError(e instanceof Error ? e.message : 'Could not access microphone');
            setErrorKind(classifyError(e));
            setStatus('error');
        }
    }, [stopTracks, wantAnalyser, fftSize]);

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
