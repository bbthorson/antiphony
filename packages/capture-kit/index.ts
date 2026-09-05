/**
 * `@antiphony/capture-kit` — headless browser audio primitives for clients
 * built on Antiphony.
 *
 * ## What is in scope
 *
 * Capturing audio from a microphone, playing it back, and deriving the
 * waveform peaks the `dev.antiphony.embed.audio` lexicon carries. These are
 * facts about audio bytes, which is what makes them shareable: a second app
 * built on Antiphony needs the identical state machine, and nothing about it
 * is specific to any product.
 *
 * ## What is deliberately NOT in scope
 *
 * - **Styling.** The hooks render nothing. `AudioPlayer` is a worked example.
 * - **Upload.** `useAudioRecorder` hands back a `Blob` and stops. The endpoint,
 *   the credential and the idempotency story are app-layer concerns.
 * - **Auth.** Nothing here knows what a session is.
 *
 * That boundary is the same one the platform draws everywhere else: Antiphony
 * owns the bytes and the services that derive facts about them; the app that
 * connects to it owns what any of it means to a user.
 */
export { useAudioRecorder, pickMimeType } from './use-audio-recorder';
export type {
    Recording,
    RecorderStatus,
    RecorderErrorKind,
    UseAudioRecorderOptions,
} from './use-audio-recorder';

export { useAudioPlayer } from './use-audio-player';
export type { PlayerStatus, UseAudioPlayerOptions } from './use-audio-player';

export { AudioPlayer } from './AudioPlayer';

export { computeWaveform } from './waveform';
