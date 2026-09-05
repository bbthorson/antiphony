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
    const { maxDurationMs, tickMs = 100 } = options;

    const [status, setStatus] = useState<RecorderStatus>('idle');
    const [recording, setRecording] = useState<Recording | null>(null);
    const [error, setError] = useState<string | null>(null);
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

    const stopTracks = useCallback(() => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
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
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            const mimeType = pickMimeType();
            const recorder = new MediaRecorder(stream, { mimeType });
            chunksRef.current = [];

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
            setStatus('error');
        }
    }, [stopTracks]);

    const reset = useCallback(() => {
        if (recording) URL.revokeObjectURL(recording.previewUrl);
        setRecording(null);
        setError(null);
        setElapsedMs(0);
        setStatus('idle');
    }, [recording]);

    return { status, recording, error, elapsedMs, start, stop, reset };
}
