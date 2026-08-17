import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from './lib/logger.js';
import { blobStore, type BlobStore } from './lib/blob-store.js';

/**
 * Audio renditions — the canonical webm/opus blob to a format some consumer can
 * actually decode.
 *
 * The canonical blob must NOT be re-encoded. Antiphony content-addresses audio,
 * so changing the bytes changes the CID and breaks the atproto blob ref plus
 * the dedup and idempotency that ride on it. So we derive a rendition and leave
 * the original alone. That is the same reason `ffmpegTrimmer` emits Opus/WebM as
 * the canonical bytes and format selection is read-path only.
 *
 * The transcode itself is byte-identical in behaviour to the version this was
 * adopted from — the argument vector below is the one that served production.
 * What changed is everything around it; see README.md, which is mostly a list of
 * things that got deleted.
 */

/** Safe path segments. Mirrors core-api's `lib/blob-path.ts`, deliberately. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * The formats this service can produce, each mapped to a FIXED argument vector.
 *
 * **The format name selects a vector; it never becomes one.** A
 * requester-influenced argument list built by string concatenation is arbitrary
 * file write and worse — an attacker-supplied `-f` or an extra `-i` turns a
 * transcoder into a file-read primitive. So the caller's string is matched
 * against these keys and discarded; what reaches `spawn` is always one of these
 * arrays.
 *
 * This is enforced twice, on both sides of the network. core-api's
 * `asRenditionFormat` narrows to its own literals before the request is made,
 * and this lookup narrows again on arrival. The duplication is intentional: a
 * service that is safe only because its caller validated is a service that
 * becomes unsafe the moment it gains a second caller.
 *
 * Mono 22.05kHz/64kbps for mp3 is transparent for speech and small — generous
 * for a phone line, which is µ-law at 8kHz, and fine for a browser download.
 * Kept as adapter policy rather than contract, the same reasoning that keeps the
 * trimmer's silence threshold out of `TrimmerPort`.
 */
const FORMATS = {
    mp3: {
        args: ['-vn', '-ac', '1', '-ar', '22050', '-b:a', '64k', '-f', 'mp3'],
        contentType: 'audio/mpeg',
    },
} as const satisfies Record<string, { args: readonly string[]; contentType: string }>;

export type RenditionFormat = keyof typeof FORMATS;

export const RENDITION_FORMATS = Object.keys(FORMATS) as RenditionFormat[];

/** Narrow a caller string to a supported format, or null. */
export function asRenditionFormat(value: unknown): RenditionFormat | null {
    if (typeof value !== 'string') return null;
    const normalised = value.trim().toLowerCase();
    return (RENDITION_FORMATS as string[]).includes(normalised)
        ? (normalised as RenditionFormat)
        : null;
}

/** A request this service will not act on. Rendered as 400 by the caller. */
export class InvalidRequestError extends Error {}

export interface RenditionRequest {
    originAppId: string;
    cid: string;
    format: RenditionFormat;
}

/**
 * Validate the two caller-supplied path segments.
 *
 * These are the only caller input that reaches a storage key, so this is the
 * whole input boundary — and it is a shape check rather than an allowlist,
 * because the caller is system-authed and the path it composes is tenant-scoped
 * either way. A `/` or a `.` here is what would let a key escape its namespace.
 */
export function parseRequest(body: unknown): RenditionRequest {
    const { originAppId, cid, format } = (body ?? {}) as Record<string, unknown>;

    if (typeof originAppId !== 'string' || !SAFE_SEGMENT.test(originAppId)) {
        throw new InvalidRequestError('originAppId must be a safe path segment');
    }
    if (typeof cid !== 'string' || !SAFE_SEGMENT.test(cid)) {
        throw new InvalidRequestError('cid must be a safe path segment');
    }
    const parsed = asRenditionFormat(format);
    if (!parsed) {
        throw new InvalidRequestError(
            `format must be one of: ${RENDITION_FORMATS.join(', ')}`,
        );
    }

    return { originAppId, cid, format: parsed };
}

/** `blobs/{originAppId}/{cid}` — the canonical source. */
export function sourcePath(req: RenditionRequest): string {
    return `blobs/${req.originAppId}/${req.cid}`;
}

/** `renditions/{originAppId}/{cid}.{format}` — the derived object. */
export function renditionPath(req: RenditionRequest): string {
    return `renditions/${req.originAppId}/${req.cid}.${req.format}`;
}

/** Run ffmpeg over a local file. */
function runFfmpeg(inputPath: string, outputPath: string, args: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        // `spawn` with an argument ARRAY, never a shell string. There is no
        // shell in the loop, so nothing in these arguments can be interpreted
        // as one — which matters less than the fixed vector above but is the
        // other half of the same guarantee.
        const proc = spawn('ffmpeg', ['-y', '-i', inputPath, ...args, outputPath]);

        let stderr = '';
        proc.stderr.on('data', (chunk: Buffer) => {
            // Bounded: ffmpeg is chatty and a pathological input could produce
            // a great deal of it, and this only ever reaches a log line.
            if (stderr.length < 8192) stderr += chunk.toString();
        });

        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
                return;
            }
            resolve();
        });
    });
}

/**
 * Assert an `ffmpeg` binary exists on PATH, for the startup probe.
 *
 * The dependency is invisible: `runFfmpeg` spawns a bare `ffmpeg` and nothing
 * in `package.json` declares one. In the Firebase Function this began as, that
 * resolved only because Google's Node runtime image happened to ship the binary;
 * `node:22-slim` does not.
 *
 * A missing binary is otherwise undetectable until the first cache miss, which
 * on this workload could be weeks after a deploy — and the first symptom would
 * be a caller hearing nothing. So the image asserts at build time and the
 * process asserts at startup.
 */
export function ffmpegAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', ['-version']);
        proc.on('error', () => resolve(false));
        proc.on('close', (code) => resolve(code === 0));
    });
}

export interface RenditionResult {
    path: string;
    bytes: number;
    /** False when the rendition already existed and nothing was transcoded. */
    transcoded: boolean;
}

/**
 * Ensure the rendition exists, transcoding it if it does not.
 *
 * Idempotent, and safe to call concurrently for the same request: two racing
 * calls both transcode and both write, but ffmpeg is deterministic for a given
 * input and argument vector, so the loser of the race overwrites with identical
 * bytes. That is the same property that lets the audio proxy serve these
 * `immutable`.
 *
 * `store` is injectable for tests; production passes nothing.
 */
export async function buildRendition(
    req: RenditionRequest,
    store: BlobStore = blobStore,
): Promise<RenditionResult> {
    const target = renditionPath(req);

    // Checked rather than assumed, because the caller's own cache check and
    // this one race: the Worker 404s on a miss, asks us, and by then another
    // request may have built it. A HEAD is far cheaper than an ffmpeg run.
    const existing = await store.head(target);
    if (existing !== null) {
        logger.info({ ...req, path: target }, '[rendition] already present');
        return { path: target, bytes: existing, transcoded: false };
    }

    const source = await store.read(sourcePath(req));
    if (source === null) {
        // The SOURCE is missing, which is not a transcode failure — it means
        // the caller asked for a rendition of audio that does not exist. A 404
        // rather than a 502, so the caller can tell "your input is wrong" from
        // "my ffmpeg broke".
        throw new InvalidRequestError(`no source blob at ${sourcePath(req)}`);
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rendition-'));
    const inputPath = path.join(workDir, `${randomUUID()}.src`);
    const outputPath = path.join(workDir, `${randomUUID()}.${req.format}`);

    try {
        fs.writeFileSync(inputPath, source);
        await runFfmpeg(inputPath, outputPath, FORMATS[req.format].args);
        const rendered = fs.readFileSync(outputPath);

        await store.write(target, rendered, FORMATS[req.format].contentType);
        logger.info(
            { ...req, path: target, sourceBytes: source.length, renderedBytes: rendered.length },
            '[rendition] built',
        );

        return { path: target, bytes: rendered.length, transcoded: true };
    } finally {
        // Instances are reused; leaked temp files would accumulate until the
        // container is recycled.
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}
