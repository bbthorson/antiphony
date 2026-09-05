---
title: "The capture kit"
description: "@antiphony/capture-kit — headless React hooks for recording, playing back, and deriving waveform peaks from audio in the browser."
---

`@antiphony/capture-kit` is the browser half of building an Antiphony client: a microphone recorder, a playback hook, and the waveform helper that produces the peaks `dev.antiphony.embed.audio` carries.

It is **headless**. The hooks render nothing and style nothing — they return state and handlers, and what you draw with them is entirely yours.

```bash
npm install @antiphony/capture-kit
```

React `^18 || ^19` is a peer dependency, so the hooks run on *your* React. (Two React copies in one tree is the "invalid hook call" error; a peer range is what prevents it.)

## Why it is a separate package

Recording audio from a microphone is a fact about audio bytes. Every client built on Antiphony needs the identical state machine — permission, MediaRecorder lifecycle, chunk assembly, MIME negotiation, cleanup — and none of it is specific to any product. That is the same line the platform draws everywhere: Antiphony owns the bytes and the services that derive facts about them; the app that connects to it owns what any of that means to a user.

So the kit stops precisely where product judgement starts:

| In the kit | Yours |
|---|---|
| Microphone permission and MediaRecorder lifecycle | What a record button looks like |
| Playback position, duration, seeking | The scrubber, the waveform, the animation |
| Waveform peaks (0–100, lexicon-shaped) | Colors, motion, layout |
| — | **Upload**: the endpoint, the credential, idempotency |
| — | **Auth**: the kit does not know what a session is |

`useAudioRecorder` hands back a `Blob` and is finished. Where those bytes go, and under whose credentials, is app-layer concern — see [the reference app](/build-your-own/reference-app/) for one way to wire it.

## `useAudioRecorder`

```tsx
import { useAudioRecorder } from '@antiphony/capture-kit';

function Recorder({ onDone }: { onDone: (blob: Blob) => void }) {
  const { status, recording, elapsedMs, error, start, stop, reset } =
    useAudioRecorder({ maxDurationMs: 120_000 });

  if (status === 'error') return <p role="alert">{error}</p>;

  if (status === 'recorded' && recording) {
    return (
      <>
        <audio src={recording.previewUrl} controls />
        <button onClick={() => onDone(recording.blob)}>Use this take</button>
        <button onClick={reset}>Record again</button>
      </>
    );
  }

  return status === 'recording'
    ? <button onClick={stop}>Stop ({Math.floor(elapsedMs / 1000)}s)</button>
    : <button onClick={start}>Record</button>;
}
```

| Returns | |
|---|---|
| `status` | `'idle' \| 'recording' \| 'recorded' \| 'error'` |
| `recording` | `{ blob, mimeType, durationMs, previewUrl }` once stopped, else `null` |
| `elapsedMs` | Live counter during the take. Renders your timer without a second clock. |
| `error` | A denied microphone arrives here as a string, not a thrown exception. |
| `errorKind` | `'permission-denied' \| 'no-device' \| 'unsupported' \| 'unknown'` |
| `analyser` | A live `AnalyserNode`, when opted in. See below. |
| `start` / `stop` / `reset` | `reset` revokes the preview object URL for you. |

`maxDurationMs` stops the take automatically — every consumer has an upload ceiling, and without it each one writes the same timer. The hook also releases the microphone if your component unmounts mid-take, so the browser's recording indicator never outlives the UI.

`mimeType` is the *clean* type (`audio/webm`, not `audio/webm;codecs=opus`), which is what the upload allowlist matches on.

### Errors: the kit classifies, you write the copy

`errorKind` is a discriminant so you can branch without matching substrings of `error` — which is browser- and locale-specific, and will betray you.

```tsx
switch (errorKind) {
  case 'permission-denied': return 'Allow microphone access to reply.';
  case 'no-device':         return 'No microphone found.';
  case 'unsupported':       return 'Recording needs a secure (https) connection.';
  default:                  return 'Could not start recording.';
}
```

That "permission was denied" is a fact about the browser; *how you say it* is a product judgement — and it reads differently in a dashboard than in an iframe on someone else's site. An iframe missing `allow="microphone"` raises `SecurityError`, which is classified as `permission-denied` too: from the caller's side it is the same situation as a user saying no.

### Live visualization

```tsx
const { analyser } = useAudioRecorder({ analyser: true, fftSize: 256 });

// in a rAF loop:
const bins = new Uint8Array(analyser.frequencyBinCount);
analyser.getByteFrequencyData(bins);
// …draw whatever you like
```

**Opt-in, because it is not free**: it opens an `AudioContext` for the duration of the take, browsers cap how many a page may hold, and a consumer that only wants the blob should not pay for one. The kit gives you the node and stops there — what you draw with the frequency data is entirely yours.

The context is closed and `analyser` returns to `null` when the take ends, including if your component unmounts mid-recording.

## `useAudioPlayer`

```tsx
import { useAudioPlayer } from '@antiphony/capture-kit';

function Player({ url, peaks }: { url: string; peaks: number[] }) {
  const { status, progress, currentTimeMs, durationMs, toggle, seekToProgress } =
    useAudioPlayer({ url, durationMs: 30_000 });

  return (
    <div onClick={(e) => {
      const r = e.currentTarget.getBoundingClientRect();
      seekToProgress((e.clientX - r.left) / r.width);
    }}>
      <button onClick={toggle}>{status === 'playing' ? 'Pause' : 'Play'}</button>
      {/* draw `peaks` however you like; `progress` is 0–1 */}
    </div>
  );
}
```

The hook **owns an `HTMLAudioElement` internally** rather than handing back a ref. That is the difference between unstyled and headless: a hook that makes you render an `<audio>` element still dictates part of your DOM. This one needs no element at all, so playback can be driven from a button, an SVG, or a waveform strip with no audio tag anywhere in your tree.

The tradeoff: native browser controls are not available. If you want `<audio controls>`, render one directly and skip the hook.

Two details worth knowing:

- **`progress` is never `NaN`.** It is `0` until the duration is known.
- **A blocked autoplay is an error string, not a rejected promise.** Calling `play()` outside a user gesture is a normal outcome, so it lands in `error` with `status: 'error'` rather than surfacing as an unhandled rejection.

Pass `durationMs` from the post's embed metadata: streamed sources report `Infinity` until fully buffered, and your hint covers that window.

## `computeWaveform`

```ts
import { computeWaveform } from '@antiphony/capture-kit/waveform';

const peaks = await computeWaveform(blob, 64); // → number[], 0–100 ints
```

Returns exactly the shape `dev.antiphony.embed.audio`'s `waveform` field accepts, computed client-side at capture time so a post carries an instantly-renderable visualization without waiting on server-side processing.

It is published at its own **`/waveform` subpath and imports no React**, so a Svelte client — or a Node script backfilling old posts — can use it without pulling React into the graph.

Silence returns all zeros rather than `NaN`, which matters: the naive normalization divides by a zero maximum, and every peak would serialize as `null` and fail lexicon validation.

## MIME negotiation

```ts
import { normalizeAudioMimeType } from '@antiphony/capture-kit/mime';

const type = normalizeAudioMimeType(blob.type, 'reply.webm'); // → 'audio/webm'
```

Antiphony's upload route matches an exact allowlist, and browsers produce two
things that allowlist rejects: a **codec-suffixed** type
(`audio/webm;codecs=opus`, what MediaRecorder reports) and **no type at all**
(`application/octet-stream` or `''` — most often a `File` off an
`<input type="file">` where the OS never populated one). This normalizes both,
using the filename as evidence in the second case.

A recording that came from `useAudioRecorder` needs no normalization — the hook
builds its `Blob` with a clean type already. This is for the blobs the kit did
*not* produce. Running it unconditionally before an upload is still right: it is
a no-op on a clean blob, and the case it catches is invisible until a user on
the wrong browser gets a 400.

`pickMimeType` lives here too, and the `/mime` subpath imports no React — an
uploader is often the one piece of a client running outside the component tree.

## `AudioPlayer`

The package also exports a small `AudioPlayer` component — play/pause, a seekable waveform, a time readout — built entirely from `useAudioPlayer`.

**It is a worked example, not the product.** It exists so the reference app has something to render and so the hook has a demonstration that its return value is enough to build a real player from. Styling is inline and neutral; every element carries a `data-antiphony-player-*` attribute if you do render it and want to restyle it from outside. An app with a design language should use the hook and render its own.
