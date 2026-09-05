# @antiphony/capture-kit

Headless browser audio primitives for [Antiphony](https://docs.antiphony.dev) clients: a microphone recorder, a playback hook, and the waveform helper that produces the peaks `dev.antiphony.embed.audio` carries.

```bash
npm install @antiphony/capture-kit
```

React `^18 || ^19` is a peer dependency, so the hooks run on your React.

```tsx
import { useAudioRecorder, useAudioPlayer, computeWaveform } from '@antiphony/capture-kit';
```

## Headless, and what that excludes

The hooks render nothing and style nothing. They return state and handlers; what you draw is yours.

The kit stops where product judgement starts. It does **not** upload — `useAudioRecorder` hands back a `Blob` and is finished, because the endpoint, the credential and the idempotency story are app-layer concerns. It does **not** know what a session is. And it carries no design language: `AudioPlayer` is a worked example so the reference app has something to render, not a component to theme.

That boundary is the same one the platform draws everywhere else. Antiphony owns the bytes and the services that derive facts about them; the app connecting to it owns what any of that means to a user. Recording audio is a fact about bytes — every client needs the identical state machine — so it lives here.

## Exports

| | |
|---|---|
| `useAudioRecorder(options?)` | MediaRecorder as a state machine. `{ status, recording, elapsedMs, error, errorKind, analyser, start, stop, reset }`. `maxDurationMs` auto-stops; `analyser: true` opts into a live `AnalyserNode`; the mic is released on unmount. |
| `useAudioPlayer({ url, durationMs?, crossOrigin? })` | Playback without an `<audio>` element in your tree. `{ status, currentTimeMs, durationMs, progress, error, play, pause, toggle, seek, seekToProgress }`. |
| `computeWaveform(blob, buckets?)` | 0–100 integer peaks, lexicon-shaped. Also at `@antiphony/capture-kit/waveform`, which imports **no React**. |
| `AudioPlayer` | A minimal transport UI built from `useAudioPlayer`. A demonstration, not a design system. |
| `pickMimeType()` | What MediaRecorder will actually give this browser, if you need to know before recording. |

Full walkthrough: **<https://docs.antiphony.dev/build-your-own/capture-kit/>**

## License

MIT — see [LICENSE](./LICENSE).
