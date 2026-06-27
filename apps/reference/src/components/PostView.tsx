import { useEffect, useState } from 'react';
import { AntiphonyClient } from '../lib/api';
import { AudioPlayer } from '../capture/AudioPlayer';
import type { AudioPostView } from '@antiphony/shared/types/audio';

/**
 * The read half of the reference flow: fetch the hydrated `AudioPostView`
 * back from core-api and render it — proving the signed audio URL, the
 * lifted transcript, and viewer state all round-trip through the contract.
 */
export function PostView({ client, postId }: { client: AntiphonyClient; postId: string }) {
    const [view, setView] = useState<AudioPostView | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setView(null);
        setError(null);
        client
            .getPost(postId)
            .then((v) => { if (!cancelled) setView(v); })
            .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
        return () => { cancelled = true; };
    }, [client, postId]);

    if (error) return <section className="card"><p className="error">{error}</p></section>;
    if (!view) return <section className="card"><p className="muted">Loading post {postId}…</p></section>;

    const { author, record, embed, viewer, kind } = view;

    return (
        <section className="card">
            <div className="row between">
                <h2>Hydrated view</h2>
                <span className={`badge badge-${kind}`}>{kind}</span>
            </div>

            <div className="meta">
                <strong>{author.displayName || author.handle || author.id}</strong>
                {viewer.isAuthor && <span className="badge badge-you">you</span>}
                <span className="muted"> · {formatCreatedAt(record.createdAt)}</span>
            </div>

            {record.title && <h3 className="title">{record.title}</h3>}
            {record.text && <p className="text">{record.text}</p>}

            {embed ? (
                <>
                    {embed.alt && <p className="muted alt">“{embed.alt}”</p>}
                    <AudioPlayer url={embed.url} waveform={embed.waveform} durationMs={embed.durationMs} />
                    {embed.transcript ? (
                        <details className="transcript">
                            <summary>Transcript ({embed.transcript.segments.length} segments)</summary>
                            <p>{embed.transcript.text ?? embed.transcript.segments.map((s) => s.text).join(' ')}</p>
                        </details>
                    ) : (
                        <p className="muted">No transcript yet (async enrichment).</p>
                    )}
                </>
            ) : (
                <p className="muted">No audio embed.</p>
            )}

            <details className="raw">
                <summary>Raw view JSON</summary>
                <pre>{JSON.stringify(view, null, 2)}</pre>
            </details>
        </section>
    );
}

/** FirestoreTimestamp can arrive as ISO string, {seconds}/{_seconds}, or Date. */
function formatCreatedAt(value: unknown): string {
    let date: Date | null = null;
    if (value instanceof Date) date = value;
    else if (typeof value === 'string' || typeof value === 'number') date = new Date(value);
    else if (value && typeof value === 'object') {
        const o = value as { seconds?: number; _seconds?: number; toDate?: () => Date };
        if (typeof o.toDate === 'function') date = o.toDate();
        else if (typeof o.seconds === 'number') date = new Date(o.seconds * 1000);
        else if (typeof o._seconds === 'number') date = new Date(o._seconds * 1000);
    }
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : 'unknown date';
}
