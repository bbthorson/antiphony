import { useAudioPlayer } from './use-audio-player';

/**
 * A minimal transport UI built entirely from `useAudioPlayer` — play/pause,
 * a seekable waveform strip, and a time readout.
 *
 * **This component is a worked example, not the product.** It exists so the
 * reference app has something to render and so the hook has a demonstration
 * that its return value is sufficient to build a real player. An app with a
 * design language should use the hook directly and render its own; nothing
 * here is meant to be themed into someone else's UI.
 *
 * Styling is inline and neutral by design — no CSS file to import, no class
 * names to collide, no theme to inherit. Every element carries a `data-*`
 * attribute so a consumer who does render this can restyle it from outside
 * without forking it.
 */

interface AudioPlayerProps {
    url: string;
    waveform?: number[];
    durationMs?: number;
}

function formatDuration(ms?: number): string {
    if (!ms) return '0:00';
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

export function AudioPlayer({ url, waveform, durationMs }: AudioPlayerProps) {
    const player = useAudioPlayer({ url, durationMs });
    const isPlaying = player.status === 'playing';

    return (
        <div data-antiphony-player="" style={{ display: 'grid', gap: 8 }}>
            {waveform && waveform.length > 0 && (
                <div
                    data-antiphony-player-waveform=""
                    role="slider"
                    tabIndex={0}
                    aria-label="Seek"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(player.progress * 100)}
                    onClick={(e) => {
                        // Fraction of the strip's width that was clicked — the
                        // whole reason `seekToProgress` takes a 0–1 rather than ms.
                        const rect = e.currentTarget.getBoundingClientRect();
                        player.seekToProgress((e.clientX - rect.left) / rect.width);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'ArrowRight') player.seek(player.currentTimeMs + 5000);
                        if (e.key === 'ArrowLeft') player.seek(player.currentTimeMs - 5000);
                    }}
                    style={{
                        display: 'flex',
                        alignItems: 'flex-end',
                        gap: 2,
                        height: 48,
                        cursor: 'pointer',
                    }}
                >
                    {waveform.map((peak, i) => (
                        <div
                            key={i}
                            style={{
                                flex: 1,
                                height: `${Math.max(2, peak)}%`,
                                // The played portion darkens: the progress
                                // indicator IS the waveform, so there is no
                                // second scrubber to keep in sync with it.
                                background: i / waveform.length <= player.progress ? '#333' : '#bbb',
                                borderRadius: 1,
                            }}
                        />
                    ))}
                </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                    data-antiphony-player-toggle=""
                    type="button"
                    onClick={player.toggle}
                    aria-label={isPlaying ? 'Pause' : 'Play'}
                    disabled={player.status === 'error'}
                    style={{ minWidth: 72 }}
                >
                    {isPlaying ? 'Pause' : 'Play'}
                </button>
                <span
                    data-antiphony-player-time=""
                    style={{ color: '#666', fontVariantNumeric: 'tabular-nums' }}
                >
                    {formatDuration(player.currentTimeMs)} / {formatDuration(player.durationMs)}
                </span>
                {player.error && (
                    <span data-antiphony-player-error="" style={{ color: '#b00' }} role="alert">
                        {player.error}
                    </span>
                )}
            </div>
        </div>
    );
}
