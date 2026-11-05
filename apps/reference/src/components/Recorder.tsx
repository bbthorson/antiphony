import { useEffect } from 'react';
import { useAudioRecorder, type Recording, type RecorderInterruption } from '@antiphony/capture-kit';

/**
 * Why a take stopped on its own, in this app's words. The kit classifies
 * (`recording.interruption`); what to say about it is the app's call.
 */
const INTERRUPTION_NOTE: Record<RecorderInterruption, string> = {
    muted: 'Stopped when the mic went quiet (page hidden or screen locked?). Kept what was recorded.',
    'device-lost': 'Stopped because the mic disconnected. Kept what was recorded.',
    'recorder-error': 'Stopped on a recorder error. Kept what was recorded.',
};

/**
 * Record / stop / preview control. Surfaces the captured `Recording` to the
 * parent via `onRecording` so the composer can upload + waveform it.
 */
export function Recorder({ onRecording }: { onRecording: (r: Recording | null) => void }) {
    // The kit's own counter: one clock for the display and any cap, and it
    // catches up when a hidden tab comes back.
    const { status, recording, error, elapsedMs, start, stop, reset } = useAudioRecorder();

    // Push the latest recording up to the composer.
    useEffect(() => {
        onRecording(recording);
    }, [recording, onRecording]);

    const seconds = (ms: number) => `${Math.floor(ms / 1000)}s`;

    return (
        <div className="panel">
            <div className="row">
                {status === 'idle' && (
                    <button onClick={start} className="btn">● Record</button>
                )}
                {status === 'recording' && (
                    <>
                        <button onClick={stop} className="btn btn-stop">■ Stop</button>
                        <span className="muted">recording… {seconds(elapsedMs)}</span>
                    </>
                )}
                {status === 'recorded' && recording && (
                    <>
                        <audio controls src={recording.previewUrl} />
                        <button onClick={reset} className="btn btn-ghost">↺ Redo</button>
                        <span className="muted">{seconds(recording.durationMs)} · {recording.mimeType}</span>
                    </>
                )}
                {status === 'error' && (
                    <>
                        <span className="error">{error}</span>
                        <button onClick={reset} className="btn btn-ghost">Try again</button>
                    </>
                )}
            </div>
            {status === 'recorded' && recording?.interruption && (
                <p className="muted">{INTERRUPTION_NOTE[recording.interruption]}</p>
            )}
        </div>
    );
}
