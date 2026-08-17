import { execFile } from 'node:child_process';

/**
 * Shared ffmpeg plumbing for the stages that pipe bytes — running a pass with
 * input on stdin and reading stdout/stderr back.
 *
 * ## Moved here from core-api, and it lost two things on the way
 *
 * This ran in `apps/core-api/src/adapters/outbound/ffmpeg/run.ts` while core-api
 * was a Node service. On Workers it cannot exist at all — no `child_process` —
 * so the trim and waveform stages moved to this container and the plumbing came
 * with them.
 *
 * Gone in the move:
 *
 *   - **`ffmpeg-static`.** A bundled per-platform binary made sense for a
 *     service installed by npm on an unknown host. This image installs ffmpeg
 *     with apt and ASSERTS it at build time, which is both simpler and stronger
 *     — and it drops a dependency whose install script this monorepo's
 *     `allowScripts` note calls out as failing silently.
 *   - **`ffmpegAvailable()`'s `accessSync` probe.** That answered "can this
 *     deployment run the stage" for a capability check inside core-api. The
 *     equivalent question is now answered by the service being reachable at
 *     all, and `rendition.ts` keeps a spawn-based probe for the startup log.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
/** Enough headroom for a 100 MB lexicon-cap upload decoded to PCM. */
const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * The binary. Off PATH, where the image's apt install puts it, with an override
 * so a developer can point at a different build.
 */
function ffmpegPath(): string {
    return process.env.ANTIPHONY_FFMPEG_PATH || 'ffmpeg';
}

/** Run ffmpeg with `bytes` on stdin, resolving stdout and stderr as buffers. */
export function runFfmpeg(
    args: string[],
    bytes: Uint8Array,
): Promise<{ stdout: Buffer; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = execFile(
            ffmpegPath(),
            args,
            { encoding: 'buffer', maxBuffer: MAX_BUFFER, timeout: DEFAULT_TIMEOUT_MS },
            (error, stdout, stderr) => {
                // ffmpeg writes everything informational to stderr, so a
                // non-zero exit is the only reliable failure signal.
                if (error) {
                    // stderr is always a Buffer here, never undefined — but it
                    // is EMPTY for any failure that happens before ffmpeg runs
                    // or that kills it from outside, which made this message
                    // read as a bare "ffmpeg failed: " with no cause at all.
                    //
                    // The reachable case is the timeout: `ffmpegAvailable()`
                    // probes X_OK at wiring time, so ENOENT/EACCES are largely
                    // guarded, but nothing guards a large file exceeding
                    // DEFAULT_TIMEOUT_MS — and that is exactly when an operator
                    // most needs the reason.
                    const detail = stderr.toString().slice(-500);
                    const cause = error.killed
                        ? `timed out after ${DEFAULT_TIMEOUT_MS}ms (${error.signal ?? 'killed'})`
                        : error.message;
                    reject(new Error(`ffmpeg failed: ${cause}${detail ? ` — ${detail}` : ''}`));
                    return;
                }
                resolve({ stdout, stderr: stderr.toString() });
            },
        );
        child.stdin?.on('error', () => {
            // ffmpeg can exit before consuming all input (bad container, for
            // one). Without this handler the EPIPE is an unhandled error event
            // and takes the process down rather than failing the stage.
        });
        child.stdin?.end(bytes);
    });
}
