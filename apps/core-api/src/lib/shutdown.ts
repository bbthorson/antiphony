import type { Logger } from './logger.js';

/**
 * Graceful shutdown on SIGTERM.
 *
 * ## Why this is not optional
 *
 * In the container, node is pid 1. **A process running as pid 1 gets no default
 * signal dispositions from the kernel**, so a SIGTERM it has installed no
 * handler for is discarded outright — the process keeps running until the
 * platform loses patience and sends SIGKILL. Measured against the deployed
 * image: without a handler, `docker stop` hung for the full 10s grace period and
 * exited 137; with one, it exits immediately.
 *
 * The Dockerfile also puts tini at pid 1, which is belt-and-braces rather than
 * redundancy: tini makes the *default* disposition apply again, so the process
 * dies promptly even if this file is ever removed or throws before installing
 * handlers. Neither alone gives both promptness and draining.
 *
 * Note this is a real gap in the App Hosting deploy too, not something the
 * Cloud Run move introduces. There the buildpack's `npm start` leaves npm at
 * pid 1 and node an ordinary child, so SIGTERM does kill it — but it kills it
 * *instantly*, mid-request. Draining is new either way.
 *
 * ## What draining can and cannot do here
 *
 * `close()` stops accepting connections and waits for in-flight requests to
 * finish. Cloud Run allows ~10s between SIGTERM and SIGKILL, so the grace below
 * sits just under that: the point is to exit on our own terms with a clean log
 * line rather than be killed.
 *
 * A long enrichment job cannot be drained and is not meant to be. An ffmpeg pass
 * alone is allowed 120s, which no shutdown budget will ever cover. That case is
 * already handled a layer down — the processing lease expires and the job
 * becomes claimable again — so the correct behaviour on shutdown is to let the
 * request die and let the lease do its job, not to stall for a drain that cannot
 * finish.
 */

/**
 * Milliseconds to wait for in-flight requests before forcing exit.
 *
 * Just under Cloud Run's ~10s SIGTERM→SIGKILL window, so the forced exit is
 * ours (exit 0, logged) rather than the platform's (SIGKILL, exit 137, silent).
 * Raising this past the platform's window does not buy more drain time — it
 * only guarantees the kill lands first and the log line never gets written.
 */
export const SHUTDOWN_GRACE_MS = 9_000;

/**
 * The part of `http.Server` this module needs. Declared structurally rather
 * than importing `http.Server` because `serve()` returns a union of HTTP/1 and
 * HTTP/2 server types, and the connection-management methods exist only on
 * some members of it — see the `in` guards below.
 */
export interface ClosableServer {
    close(callback?: (err?: Error) => void): unknown;
    closeIdleConnections?: () => void;
    closeAllConnections?: () => void;
}

export interface ShutdownOptions {
    server: ClosableServer;
    logger: Logger;
    /** Overridable for tests; defaults to {@link SHUTDOWN_GRACE_MS}. */
    graceMs?: number;
    /** Seam so tests can assert the exit code without killing the runner. */
    exit?: (code: number) => void;
    /** Seam so tests can install handlers on a stub instead of the real process. */
    onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
}

/**
 * Install SIGTERM/SIGINT handlers that drain `server` and then exit.
 *
 * Returns the shutdown function itself, which is what makes this testable
 * without emitting real process signals.
 */
export function installShutdownHandlers(options: ShutdownOptions): (signal: NodeJS.Signals) => void {
    const {
        server,
        logger,
        graceMs = SHUTDOWN_GRACE_MS,
        exit = (code) => process.exit(code),
        onSignal = (signal, handler) => {
            process.on(signal, handler);
        },
    } = options;

    let shuttingDown = false;

    const shutdown = (signal: NodeJS.Signals): void => {
        // Orchestrators re-send SIGTERM when the first one appears not to have
        // taken. Without this latch the second signal starts a second drain,
        // whose timer can force-exit while the first is still finishing.
        if (shuttingDown) {
            logger.debug({ signal }, '[core-api] already shutting down, ignoring repeat signal');
            return;
        }
        shuttingDown = true;
        logger.info({ signal, graceMs }, '[core-api] draining');

        const forced = setTimeout(() => {
            logger.warn(
                { signal, graceMs },
                '[core-api] grace period expired with requests still in flight — forcing exit',
            );
            // Sockets still mid-request. Dropping them explicitly makes the
            // truncation ours and immediate, instead of leaving the peer to
            // discover it when the platform kills the process a moment later.
            server.closeAllConnections?.();
            exit(0);
        }, graceMs);
        // Unref'd so the timer itself never keeps the process alive: if the drain
        // finishes early, node is free to exit as soon as `close` calls back.
        forced.unref?.();

        server.close((err) => {
            clearTimeout(forced);
            if (err) {
                // Reached when the server was not listening — nothing was
                // draining, so this is a failed assumption, not a failed drain.
                logger.error({ err, signal }, '[core-api] error while closing server');
                exit(1);
                return;
            }
            logger.info({ signal }, '[core-api] drained, exiting');
            exit(0);
        });

        // `close()` waits for every connection to end, and an idle keep-alive
        // connection never does on its own — so without this a client that
        // merely *had* a connection open holds shutdown to the full grace period.
        // Idle sockets are safe to drop; in-flight ones are untouched.
        server.closeIdleConnections?.();
    };

    // SIGTERM is what Cloud Run sends. SIGINT is here so a local Ctrl-C takes
    // the same path rather than exercising an untested one.
    onSignal('SIGTERM', () => shutdown('SIGTERM'));
    onSignal('SIGINT', () => shutdown('SIGINT'));

    return shutdown;
}
