import { useCallback, useState } from 'react';
import type { Recording } from '../capture/use-audio-recorder';
import { computeWaveform } from '../capture/waveform';
import { Recorder } from './Recorder';
import { AntiphonyClient } from '../lib/api';
import type { CreateAudioPostRequest } from '@antiphony/shared/api-codecs';
import type { AudioEmbed } from '@antiphony/shared/types/audio';

type Stage = 'idle' | 'waveform' | 'uploading' | 'creating' | 'done' | 'error';

/**
 * The create half of the reference flow:
 *   record → computeWaveform → uploadAudio → build embed.audio → createPost.
 *
 * On success it hands the new post id up so the parent can fetch + render
 * the hydrated view — closing the contract loop.
 */
export function PostComposer({ client, onCreated }: { client: AntiphonyClient; onCreated: (postId: string) => void }) {
    const [text, setText] = useState('');
    const [title, setTitle] = useState('');
    const [alt, setAlt] = useState('');
    const [recording, setRecording] = useState<Recording | null>(null);
    const [stage, setStage] = useState<Stage>('idle');
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const onRecording = useCallback((r: Recording | null) => setRecording(r), []);

    const canSubmit = (text.trim().length > 0 || recording !== null) && stage !== 'uploading' && stage !== 'creating';

    async function submit() {
        setErrorMsg(null);
        try {
            let embed: AudioEmbed | undefined;
            if (recording) {
                setStage('waveform');
                const waveform = await computeWaveform(recording.blob);

                setStage('uploading');
                const filename = `recording.${recording.mimeType.split('/')[1] ?? 'webm'}`;
                // The server hashes the bytes and returns the canonical blob
                // ref (CID + mimeType + size) — embed it verbatim.
                const audioBlob = await client.uploadAudio(recording.blob, filename);

                embed = {
                    $type: 'dev.antiphony.embed.audio',
                    audio: audioBlob,
                    durationMs: recording.durationMs,
                    alt: alt.trim() || undefined,
                    waveform,
                };
            }

            setStage('creating');
            const req: CreateAudioPostRequest = {
                text: text.trim(),
                title: title.trim() || undefined,
                embed,
            };
            const postId = await client.createPost(req);
            setStage('done');
            onCreated(postId);
        } catch (e) {
            setErrorMsg(e instanceof Error ? e.message : String(e));
            setStage('error');
        }
    }

    return (
        <section className="card">
            <h2>Compose a post</h2>

            <label className="field">
                <span>Title <em>(optional — prompts only)</em></span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A headline" />
            </label>

            <label className="field">
                <span>Text</span>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="What's the question?" />
            </label>

            <label className="field">
                <span>Audio description / alt <em>(optional)</em></span>
                <input value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="Short description of the audio" />
            </label>

            <Recorder onRecording={onRecording} />

            <div className="row">
                <button onClick={submit} disabled={!canSubmit} className="btn btn-primary">Create post →</button>
                <StageLabel stage={stage} />
            </div>

            {errorMsg && <p className="error">{errorMsg}</p>}
        </section>
    );
}

function StageLabel({ stage }: { stage: Stage }) {
    const labels: Record<Stage, string> = {
        idle: '',
        waveform: 'computing waveform…',
        uploading: 'uploading audio…',
        creating: 'creating post…',
        done: 'created ✓',
        error: '',
    };
    const label = labels[stage];
    return label ? <span className="muted">{label}</span> : null;
}
