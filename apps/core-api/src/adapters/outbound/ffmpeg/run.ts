import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';

/**
 * Shared ffmpeg plumbing for the local-compute adapters — binary resolution,
 * the availability probe, and running a pass with bytes on stdin.
 *
 * Extracted when the waveform stage (step 6) became the second consumer. Both
 * stages resolve the same binary and honour the same override, so a second
 * copy would let a deployment's `ANTIPHONY_FFMPEG_PATH` govern one stage and
 * not the other.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
/** Enough headroom for a 100 MB lexicon-cap upload decoded to PCM. */
const MAX_BUFFER = 512 * 1024 * 1024;

let probed: { path: string; ok: boolean } | undefined;

/**
 * Whether an ffmpeg binary is resolvable AND executable, checked when providers
 * are wired.
 *
 * Without this the trim and waveform capabilities would advertise `true` on a
 * platform `ffmpeg-static` has no build for — or for a typo'd
 * `ANTIPHONY_FFMPEG_PATH` — then fail every post at run time. A capability that
 * lies is worse than one that is absent: the stage settles `failed` per post
 * instead of an honest `skipped`.
 */
export function ffmpegAvailable(): boolean {
    const path = process.env.ANTIPHONY_FFMPEG_PATH || ffmpegStatic;
    if (!path) return false;
    // Memoized per path so a per-request capability check is not a syscall
    // every time, while a changed env var still re-probes.
    if (probed?.path === path) return probed.ok;
    let ok = false;
    try {
        // Existence is not enough — a path that is present but not executable
        // fails identically at run time, which is the case this guards.
        accessSync(path, constants.X_OK);
        ok = true;
    } catch {
        ok = false;
    }
    probed = { path, ok };
    return ok;
}

function ffmpegPath(): string {
    // Overridable so a deployment can point at a system ffmpeg instead of
    // shipping the bundled binary.
    const configured = process.env.ANTIPHONY_FFMPEG_PATH;
    if (configured) return configured;
    if (!ffmpegStatic) throw new Error('ffmpeg binary not available');
    return ffmpegStatic;
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
