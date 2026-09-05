import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Headless audio-playback hook — the read half of the capture kit, and the
 * counterpart to `useAudioRecorder`.
 *
 * **It owns an `HTMLAudioElement` internally rather than handing back a ref.**
 * That is the difference between "unstyled" and "headless": a hook that
 * requires the caller to render an `<audio>` element still dictates part of
 * their DOM. This one requires no element at all, so a consumer can drive
 * playback from a button, a waveform strip, an SVG, or the Vox Pop dot-mark,
 * with no audio tag anywhere in their tree.
 *
 * The tradeoff is that native browser controls are not available — a caller
 * who wants `<audio controls>` should render one directly and skip this hook.
 * `AudioPlayer` in this package shows the other path: a full transport UI
 * built from these values alone.
 */

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface UseAudioPlayerOptions {
    /** Audio URL. Changing it loads the new source and resets position. */
    url: string;
    /**
     * Duration in ms from the post's `embed` metadata.
     *
     * A fallback for the window before `loadedmetadata` fires, and for
     * streamed sources whose `duration` reads `Infinity`. When the element
     * reports a real duration, that wins — it is the file itself talking.
     */
    durationMs?: number;
    /** `crossOrigin` for the underlying element. Needed for CORS-gated blobs. */
    crossOrigin?: 'anonymous' | 'use-credentials';
}

export function useAudioPlayer(options: UseAudioPlayerOptions) {
    const { url, durationMs: durationHint, crossOrigin } = options;

    const [status, setStatus] = useState<PlayerStatus>('idle');
    const [currentTimeMs, setCurrentTimeMs] = useState(0);
    const [durationMs, setDurationMs] = useState(durationHint ?? 0);
    const [error, setError] = useState<string | null>(null);

    const audioRef = useRef<HTMLAudioElement | null>(null);

    /**
     * Create the element and subscribe. Re-runs when `url` changes, which is
     * also the reset: a fresh element means no stale buffer, no stale position.
     *
     * `new Audio()` rather than `document.createElement` for the same result in
     * fewer characters; it is never attached to the document, so nothing about
     * the caller's layout changes.
     */
    useEffect(() => {
        if (typeof Audio === 'undefined') return; // SSR / non-DOM runtime

        const audio = new Audio();
        if (crossOrigin) audio.crossOrigin = crossOrigin;
        audio.preload = 'metadata';
        audio.src = url;
        audioRef.current = audio;

        setStatus('loading');
        setCurrentTimeMs(0);
        setError(null);

        const onLoadedMetadata = () => {
            // A streamed source reports Infinity until it has been fully
            // buffered; keep the caller's hint in that case rather than
            // rendering "Infinity:NaN".
            if (Number.isFinite(audio.duration)) setDurationMs(Math.round(audio.duration * 1000));
            setStatus('paused');
        };
        const onTimeUpdate = () => setCurrentTimeMs(Math.round(audio.currentTime * 1000));
        const onPlay = () => setStatus('playing');
        const onPause = () => setStatus((s) => (s === 'ended' ? s : 'paused'));
        const onEnded = () => setStatus('ended');
        const onError = () => {
            setError(audio.error?.message ?? 'Could not load audio');
            setStatus('error');
        };

        audio.addEventListener('loadedmetadata', onLoadedMetadata);
        audio.addEventListener('timeupdate', onTimeUpdate);
        audio.addEventListener('play', onPlay);
        audio.addEventListener('pause', onPause);
        audio.addEventListener('ended', onEnded);
        audio.addEventListener('error', onError);

        return () => {
            audio.removeEventListener('loadedmetadata', onLoadedMetadata);
            audio.removeEventListener('timeupdate', onTimeUpdate);
            audio.removeEventListener('play', onPlay);
            audio.removeEventListener('pause', onPause);
            audio.removeEventListener('ended', onEnded);
            audio.removeEventListener('error', onError);
            // Pause and drop the source before releasing the element, or the
            // browser keeps buffering a file nothing is listening to.
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            audioRef.current = null;
        };
    }, [url, crossOrigin]);

    const play = useCallback(async () => {
        const audio = audioRef.current;
        if (!audio) return;
        try {
            // `play()` rejects when the browser's autoplay policy blocks a call
            // that did not come from a user gesture. That is a normal outcome,
            // not a broken file — surface it as an error string, not a throw.
            await audio.play();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Playback was blocked');
            setStatus('error');
        }
    }, []);

    const pause = useCallback(() => {
        audioRef.current?.pause();
    }, []);

    const toggle = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused) void play();
        else audio.pause();
    }, [play]);

    /** Seek to an absolute position in ms. Clamped to the known duration. */
    const seek = useCallback((ms: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        const maxMs = Number.isFinite(audio.duration) ? audio.duration * 1000 : Infinity;
        const clamped = Math.max(0, Math.min(ms, maxMs));
        audio.currentTime = clamped / 1000;
        // `timeupdate` is throttled by the browser (~4/sec), so a seek would
        // otherwise leave the rendered position stale until the next tick —
        // visible as a scrubber that lags the click that moved it.
        setCurrentTimeMs(Math.round(clamped));
    }, []);

    /** Seek by fraction of total duration (0–1) — what a waveform click gives you. */
    const seekToProgress = useCallback(
        (fraction: number) => {
            if (durationMs > 0) seek(fraction * durationMs);
        },
        [seek, durationMs],
    );

    return {
        status,
        currentTimeMs,
        durationMs,
        /** 0–1. Zero when the duration is not yet known, never NaN. */
        progress: durationMs > 0 ? Math.min(1, currentTimeMs / durationMs) : 0,
        error,
        play,
        pause,
        toggle,
        seek,
        seekToProgress,
    };
}
