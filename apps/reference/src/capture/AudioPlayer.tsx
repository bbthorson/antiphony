/**
 * Neutral audio player primitive — renders a waveform strip above a native
 * `<audio>` control. Capture-kit seed; no product styling beyond inline
 * neutral grays.
 */

interface AudioPlayerProps {
    url: string;
    waveform?: number[];
    durationMs?: number;
}

function formatDuration(ms?: number): string {
    if (!ms) return '';
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

export function AudioPlayer({ url, waveform, durationMs }: AudioPlayerProps) {
    return (
        <div style={{ display: 'grid', gap: 8 }}>
            {waveform && waveform.length > 0 && (
                <div
                    aria-hidden
                    style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 48 }}
                >
                    {waveform.map((peak, i) => (
                        <div
                            key={i}
                            style={{
                                flex: 1,
                                height: `${Math.max(2, peak)}%`,
                                background: '#888',
                                borderRadius: 1,
                            }}
                        />
                    ))}
                </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <audio controls src={url} style={{ flex: 1 }} />
                {durationMs ? <span style={{ color: '#666', fontVariantNumeric: 'tabular-nums' }}>{formatDuration(durationMs)}</span> : null}
            </div>
        </div>
    );
}
