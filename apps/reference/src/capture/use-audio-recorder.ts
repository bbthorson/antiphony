import { useCallback, useRef, useState } from 'react';

/**
 * Neutral browser audio-recorder hook — the seed of the future Antiphony
 * `capture-kit`. No product branding, no app coupling: just MediaRecorder
 * wrapped in a small React state machine that yields a `Recording`
 * (blob + clean MIME + duration) ready to hand to the upload step.
 *
 * Extraction note: this file plus `waveform.ts` and `AudioPlayer.tsx` are
 * the candidate primitives to lift into `packages/capture-kit` once a
 * second consumer needs them (Stream 1.5 → capture-kit split).
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

/** Pick the first MediaRecorder MIME the browser supports from our allowlist. */
function pickMimeType(): string {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
    for (const c of candidates) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
    }
    return 'audio/webm';
}

export function useAudioRecorder() {
    const [status, setStatus] = useState<RecorderStatus>('idle');
    const [recording, setRecording] = useState<Recording | null>(null);
    const [error, setError] = useState<string | null>(null);

    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const startedAtRef = useRef<number>(0);
    const streamRef = useRef<MediaStream | null>(null);

    const stopTracks = useCallback(() => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
    }, []);

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
                setStatus('recorded');
            };

            startedAtRef.current = Date.now();
            recorder.start();
            recorderRef.current = recorder;
            setStatus('recording');
        } catch (e) {
            stopTracks();
            setError(e instanceof Error ? e.message : 'Could not access microphone');
            setStatus('error');
        }
    }, [stopTracks]);

    const stop = useCallback(() => {
        recorderRef.current?.stop();
        recorderRef.current = null;
    }, []);

    const reset = useCallback(() => {
        if (recording) URL.revokeObjectURL(recording.previewUrl);
        setRecording(null);
        setError(null);
        setStatus('idle');
    }, [recording]);

    return { status, recording, error, start, stop, reset };
}
