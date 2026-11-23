import { describe, it, expect, vi, beforeEach } from 'vitest';

const runFfmpeg = vi.fn();

vi.mock('./lib/ffmpeg.js', () => ({
    runFfmpeg,
}));

const { trim, waveform, TRIM_OUTPUT_MIME } = await import('./stages.js');

beforeEach(() => {
    vi.resetAllMocks();
});

describe('trim', () => {
    const input = new Uint8Array([1, 2, 3, 4]);

    it('throws when ffmpeg reports no duration in pass 1', async () => {
        runFfmpeg.mockResolvedValueOnce({ stdout: Buffer.alloc(0), stderr: 'no duration line here' });

        await expect(trim(input, 'audio/webm')).rejects.toThrow('ffmpeg reported no duration for the input');
        expect(runFfmpeg).toHaveBeenCalledTimes(1);
    });

    it('passes bytes through without re-encoding when there is nothing to cut and input is already audio/webm', async () => {
        runFfmpeg.mockResolvedValueOnce({
            stdout: Buffer.alloc(0),
            stderr: '  Duration: 00:00:05.25, start: 0.000000, bitrate: 48 kb/s\n',
        });

        const result = await trim(input, TRIM_OUTPUT_MIME);

        expect(runFfmpeg).toHaveBeenCalledTimes(1);
        expect(result.mimeType).toBe(TRIM_OUTPUT_MIME);
        expect(result.durationMs).toBe(5250);
        expect(result.bytes.equals(Buffer.from(input))).toBe(true);
    });

    it('still re-encodes when nothing is cut if input is not audio/webm (e.g. denoised MP3)', async () => {
        const encoded = Buffer.from([9, 8, 7, 6]);
        runFfmpeg
            .mockResolvedValueOnce({
                stdout: Buffer.alloc(0),
                stderr: '  Duration: 00:00:04.00, start: 0.000000\n',
            })
            .mockResolvedValueOnce({ stdout: encoded, stderr: '' })
            .mockResolvedValueOnce({
                stdout: Buffer.alloc(0),
                stderr: '  Duration: 00:00:04.02, start: 0.000000\n',
            });

        const result = await trim(input, 'audio/mpeg');

        expect(runFfmpeg).toHaveBeenCalledTimes(3);
        expect(result.mimeType).toBe(TRIM_OUTPUT_MIME);
        expect(result.bytes).toBe(encoded);
        expect(result.durationMs).toBe(4020);
    });

    it('cuts leading and trailing silence, encodes to WebM/Opus, and measures duration from the encoded output', async () => {
        const encoded = Buffer.from([10, 20, 30]);
        runFfmpeg
            .mockResolvedValueOnce({
                stdout: Buffer.alloc(0),
                stderr: [
                    '  Duration: 00:00:10.00, start: 0.000000',
                    '[silencedetect @ 0x1] silence_start: 0',
                    '[silencedetect @ 0x1] silence_end: 2.0 | silence_duration: 2.0',
                    '[silencedetect @ 0x1] silence_start: 8.0',
                    '[silencedetect @ 0x1] silence_end: 10.0 | silence_duration: 2.0',
                ].join('\n'),
            })
            .mockResolvedValueOnce({ stdout: encoded, stderr: '' })
            .mockResolvedValueOnce({
                stdout: Buffer.alloc(0),
                stderr: '  Duration: 00:00:06.30, start: 0.000000\n',
            });

        const result = await trim(input, TRIM_OUTPUT_MIME);

        expect(runFfmpeg).toHaveBeenCalledTimes(3);
        const cutArgs = runFfmpeg.mock.calls[1][0] as string[];
        expect(cutArgs).toContain('-ss');
        expect(cutArgs).toContain('-t');
        expect(cutArgs).toContain('libopus');
        expect(cutArgs).toContain('webm');
        expect(result.mimeType).toBe(TRIM_OUTPUT_MIME);
        expect(result.bytes).toBe(encoded);
        expect(result.durationMs).toBe(6300);
    });

    it('throws when the cut pass produces zero bytes', async () => {
        runFfmpeg
            .mockResolvedValueOnce({
                stdout: Buffer.alloc(0),
                stderr: '  Duration: 00:00:03.00, start: 0.000000\n',
            })
            .mockResolvedValueOnce({ stdout: Buffer.alloc(0), stderr: '' });

        await expect(trim(input, 'audio/mpeg')).rejects.toThrow('ffmpeg produced an empty trimmed variant');
        expect(runFfmpeg).toHaveBeenCalledTimes(2);
    });

    it('falls back to the requested window duration if the probe pass reports no duration', async () => {
        const encoded = Buffer.from([1, 2, 3]);
        runFfmpeg
            .mockResolvedValueOnce({
                stdout: Buffer.alloc(0),
                stderr: '  Duration: 00:00:03.50, start: 0.000000\n',
            })
            .mockResolvedValueOnce({ stdout: encoded, stderr: '' })
            .mockResolvedValueOnce({ stdout: Buffer.alloc(0), stderr: 'no duration' });

        const result = await trim(input, 'audio/mpeg');

        expect(result.bytes).toBe(encoded);
        expect(result.durationMs).toBe(3500);
    });
});

describe('waveform', () => {
    const input = new Uint8Array([1, 2, 3]);

    it('decodes s16le 8kHz PCM and returns normalized peaks', async () => {
        const samples = new Int16Array(8000); // 1 second at 8 kHz
        for (let i = 0; i < samples.length; i++) {
            samples[i] = i % 2 === 0 ? 16384 : -16384;
        }
        const pcm = Buffer.from(samples.buffer);
        runFfmpeg.mockResolvedValueOnce({ stdout: pcm, stderr: '' });

        const result = await waveform(input);

        expect(runFfmpeg).toHaveBeenCalledTimes(1);
        expect(result.peaks).toHaveLength(20);
        expect(result.peaks.every((p) => p >= 0 && p <= 100)).toBe(true);
    });

    it('throws when ffmpeg decodes fewer than 2 bytes of PCM', async () => {
        runFfmpeg.mockResolvedValueOnce({ stdout: Buffer.from([0x01]), stderr: '' });

        await expect(waveform(input)).rejects.toThrow('ffmpeg decoded no audio for the waveform');
    });

    it('handles an odd byteOffset in the backing ArrayBuffer without throwing on Int16Array alignment', async () => {
        // Place valid s16le samples starting at byteOffset 1 (odd).
        const backing = new ArrayBuffer(1 + 200);
        const view = new DataView(backing, 1, 200);
        for (let i = 0; i < 100; i++) {
            view.setInt16(i * 2, 10000, true);
        }
        const unaligned = Buffer.from(backing, 1, 200);
        expect(unaligned.byteOffset % 2).toBe(1);

        runFfmpeg.mockResolvedValueOnce({ stdout: unaligned, stderr: '' });

        const result = await waveform(input);

        expect(result.peaks.length).toBeGreaterThan(0);
        expect(result.peaks.every((p) => p > 0 && p <= 100)).toBe(true);
    });

    it('floors an odd trailing byte rather than reading past the PCM buffer', async () => {
        // 5 bytes = 2 complete s16le samples + 1 stray trailing byte.
        const oddLen = Buffer.alloc(5);
        oddLen.writeInt16LE(12000, 0);
        oddLen.writeInt16LE(-12000, 2);
        oddLen[4] = 0xff;

        runFfmpeg.mockResolvedValueOnce({ stdout: oddLen, stderr: '' });

        const result = await waveform(input);

        expect(result.peaks.length).toBeGreaterThan(0);
    });
});
