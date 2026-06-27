import { useEffect, useState } from 'react';
import { useAudioRecorder, type Recording } from '../capture/use-audio-recorder';

/**
 * Record / stop / preview control. Surfaces the captured `Recording` to the
 * parent via `onRecording` so the composer can upload + waveform it.
 */
export function Recorder({ onRecording }: { onRecording: (r: Recording | null) => void }) {
    const { status, recording, error, start, stop, reset } = useAudioRecorder();
    const [elapsed, setElapsed] = useState(0);

    // Live elapsed timer while recording.
    useEffect(() => {
        if (status !== 'recording') return;
        const startedAt = Date.now();
        const id = setInterval(() => setElapsed(Date.now() - startedAt), 200);
        return () => clearInterval(id);
    }, [status]);

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
                        <span className="muted">recording… {seconds(elapsed)}</span>
                    </>
                )}
                {status === 'recorded' && recording && (
                    <>
                        <audio controls src={recording.previewUrl} />
                        <button onClick={() => { reset(); setElapsed(0); }} className="btn btn-ghost">↺ Redo</button>
                        <span className="muted">{seconds(recording.durationMs)} · {recording.mimeType}</span>
                    </>
                )}
                {status === 'error' && (
                    <>
                        <span className="error">{error}</span>
                        <button onClick={() => { reset(); setElapsed(0); }} className="btn btn-ghost">Try again</button>
                    </>
                )}
            </div>
        </div>
    );
}
