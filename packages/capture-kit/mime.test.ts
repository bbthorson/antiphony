import { describe, it, expect, vi, afterEach } from 'vitest';
import { pickMimeType, normalizeAudioMimeType } from './mime';

afterEach(() => vi.unstubAllGlobals());

describe('pickMimeType', () => {
    it('prefers opus-in-webm when supported', () => {
        vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
        expect(pickMimeType()).toBe('audio/webm;codecs=opus');
    });

    it('falls through the allowlist to what the browser does support', () => {
        // Safari: no webm at all, mp4 only.
        vi.stubGlobal('MediaRecorder', {
            isTypeSupported: (t: string) => t === 'audio/mp4',
        });
        expect(pickMimeType()).toBe('audio/mp4');
    });

    it('returns a usable default where MediaRecorder is absent', () => {
        vi.stubGlobal('MediaRecorder', undefined);
        expect(pickMimeType()).toBe('audio/webm');
    });
});

describe('normalizeAudioMimeType', () => {
    it('passes a clean audio type through unchanged', () => {
        expect(normalizeAudioMimeType('audio/webm', 'prompt.webm')).toBe('audio/webm');
        expect(normalizeAudioMimeType('audio/m4a', 'prompt.m4a')).toBe('audio/m4a');
    });

    it('strips the codec parameter an exact-match allowlist would reject', () => {
        expect(normalizeAudioMimeType('audio/webm;codecs=opus', 'p.webm')).toBe('audio/webm');
        expect(normalizeAudioMimeType('audio/mp4; codecs="mp4a.40.2"', 'p.m4a')).toBe('audio/mp4');
    });

    it('falls back to the filename when the blob claims no audio type', () => {
        // The `<input type="file">` case: the OS never populated a type.
        expect(normalizeAudioMimeType('application/octet-stream', 'reply.webm')).toBe('audio/webm');
        expect(normalizeAudioMimeType('', 'reply.m4a')).toBe('audio/m4a');
        expect(normalizeAudioMimeType(undefined, 'reply.mp3')).toBe('audio/mpeg');
        expect(normalizeAudioMimeType('', 'reply.wav')).toBe('audio/wav');
    });

    it('uses the fallback when neither the type nor the extension says anything', () => {
        expect(normalizeAudioMimeType('', 'recording')).toBe('audio/webm');
        expect(normalizeAudioMimeType('', 'recording.xyz', 'audio/mp4')).toBe('audio/mp4');
    });

    it('is case-insensitive on both inputs', () => {
        expect(normalizeAudioMimeType('AUDIO/WEBM', 'a.webm')).toBe('audio/webm');
        expect(normalizeAudioMimeType('', 'RECORDING.M4A')).toBe('audio/m4a');
    });

    it('is a no-op on what useAudioRecorder produces', () => {
        // The kit builds its Blob with a clean type already, so this only ever
        // matters for blobs the kit did not produce.
        expect(normalizeAudioMimeType('audio/webm', 'take.webm')).toBe('audio/webm');
    });
});
