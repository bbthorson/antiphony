import { describe, it, expect, afterEach } from 'vitest';
import { runFfmpeg, ffmpegAvailable } from './run.js';

/**
 * Tests for the shared ffmpeg plumbing. These spawn a real process, but never
 * ffmpeg itself — `ANTIPHONY_FFMPEG_PATH` is pointed at small system binaries
 * so the failure paths are exercised without decoding anything.
 *
 * Env is test state here, same as the provider-selection tests: a stray
 * `ANTIPHONY_FFMPEG_PATH` in the developer's shell would otherwise decide
 * these.
 */

const saved = process.env.ANTIPHONY_FFMPEG_PATH;

afterEach(() => {
    if (saved === undefined) delete process.env.ANTIPHONY_FFMPEG_PATH;
    else process.env.ANTIPHONY_FFMPEG_PATH = saved;
});

describe('runFfmpeg', () => {
    it('reports the spawn failure rather than an empty message', async () => {
        // stderr is empty when the binary never runs, so before this the whole
        // message was a bare "ffmpeg failed: " with no cause in it.
        process.env.ANTIPHONY_FFMPEG_PATH = '/nonexistent/ffmpeg';
        await expect(runFfmpeg(['-version'], new Uint8Array())).rejects.toThrow(/ENOENT/);
    });

    it('includes ffmpeg stderr when the process ran and failed', async () => {
        // `false` exits non-zero silently; use a shell so there is real stderr
        // to carry through.
        process.env.ANTIPHONY_FFMPEG_PATH = '/bin/sh';
        await expect(
            runFfmpeg(['-c', 'echo "Invalid data found when processing input" >&2; exit 1'], new Uint8Array()),
        ).rejects.toThrow(/Invalid data found when processing input/);
    });

    it('resolves stdout and stderr on success', async () => {
        process.env.ANTIPHONY_FFMPEG_PATH = '/bin/sh';
        const { stdout, stderr } = await runFfmpeg(['-c', 'echo out; echo err >&2'], new Uint8Array());
        expect(stdout.toString().trim()).toBe('out');
        expect(stderr.trim()).toBe('err');
    });

    it('does not die on EPIPE when the process exits without reading stdin', async () => {
        // A bad container makes ffmpeg exit before consuming the upload. Without
        // the stdin error handler this is an unhandled error event that takes
        // the whole process down rather than failing one stage.
        process.env.ANTIPHONY_FFMPEG_PATH = '/bin/sh';
        const big = new Uint8Array(1024 * 1024);
        const { stdout } = await runFfmpeg(['-c', 'exit 0'], big);
        expect(stdout.length).toBe(0);
    });
});

describe('ffmpegAvailable', () => {
    it('is false for a path that does not exist', () => {
        process.env.ANTIPHONY_FFMPEG_PATH = '/nonexistent/ffmpeg';
        expect(ffmpegAvailable()).toBe(false);
    });

    it('is false for a path that exists but is not executable', () => {
        // The case a bare existence check would wrongly report as available,
        // advertising the stage and then failing every post.
        process.env.ANTIPHONY_FFMPEG_PATH = '/etc/hosts';
        expect(ffmpegAvailable()).toBe(false);
    });

    it('is true for an executable path', () => {
        process.env.ANTIPHONY_FFMPEG_PATH = '/bin/sh';
        expect(ffmpegAvailable()).toBe(true);
    });
});
