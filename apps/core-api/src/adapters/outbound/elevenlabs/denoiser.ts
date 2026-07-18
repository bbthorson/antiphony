import type { DenoiserPort, DenoiseInput, DenoiseResult } from '@antiphony/core/ports/audio-denoiser';
import { audioFile, postForm } from './client.js';

/**
 * ElevenLabs Voice Isolator denoiser — the reference deployment's `DenoiserPort`.
 *
 * **The endpoint TRANSCODES.** Whatever container goes in, MP3 (`audio/mpeg`)
 * comes out — verified live: a WAV upload returned `content-type: audio/mpeg`
 * with ID3 magic bytes. The published docs describe the response as an empty
 * JSON object, which is simply wrong, so this adapter is written against
 * observed behavior.
 *
 * That is why the result's `mimeType` is read from the RESPONSE and never
 * echoed from the input. Echoing it (as the stub does, correctly, since the
 * stub is a pass-through) would store MP3 bytes labelled `audio/webm`. The
 * blob is content-addressed and served to browsers by signed URL with its
 * stored content type, so the failure would surface as silently broken
 * playback — no exception, no failed stage, nothing in the logs.
 */

/** What the API has been observed to return, used only if the header is absent. */
const FALLBACK_MIME = 'audio/mpeg';

export const elevenLabsDenoiser: DenoiserPort = {
    async denoise(input: DenoiseInput): Promise<DenoiseResult> {
        const form = new FormData();
        // Note the field name: `audio` here, vs `file` for speech-to-text.
        form.append('audio', audioFile(input.bytes, input.mimeType));

        const res = await postForm('/audio-isolation', form);

        // Strip any `; codecs=…` / charset parameter: this value is stored as
        // the blob's content type and handed to browsers verbatim.
        const contentType = res.headers.get('content-type')?.split(';')[0]?.trim();
        const bytes = new Uint8Array(await res.arrayBuffer());

        if (bytes.length === 0) {
            // A 200 with no body would otherwise be content-addressed and
            // stored as a valid-looking empty blob, replacing playable audio
            // with silence. Fail the stage instead.
            throw new Error('ElevenLabs /audio-isolation returned an empty body');
        }

        return {
            bytes,
            mimeType: contentType && contentType !== 'application/json' ? contentType : FALLBACK_MIME,
        };
    },
};
