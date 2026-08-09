import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';
import { installShutdownHandlers, SHUTDOWN_GRACE_MS, type ClosableServer } from './shutdown.js';

/**
 * Unit tests for the SIGTERM drain.
 *
 * The behaviour under test is a sequence of side effects on a server that is
 * shutting down, which is why `installShutdownHandlers` returns the shutdown
 * function and takes `exit`/`onSignal` seams: the alternative is emitting real
 * signals at the vitest process and calling the real `process.exit`, which ends
 * the run rather than testing it.
 */

/** A server whose `close` callback fires only when the test says so. */
function fakeServer(): ClosableServer & {
    finishDrain: (err?: Error) => void;
    closeCalls: number;
    idleCalls: number;
    allCalls: number;
} {
    let pending: ((err?: Error) => void) | undefined;
    const state = {
        closeCalls: 0,
        idleCalls: 0,
        allCalls: 0,
        close(callback?: (err?: Error) => void) {
            state.closeCalls += 1;
            pending = callback;
        },
        closeIdleConnections() {
            state.idleCalls += 1;
        },
        closeAllConnections() {
            state.allCalls += 1;
        },
        finishDrain(err?: Error) {
            pending?.(err);
        },
    };
    return state;
}

function fakeLogger(): Logger {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as unknown as Logger;
}

describe('installShutdownHandlers', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('registers for the signals the platform actually sends', () => {
        const registered: string[] = [];
        installShutdownHandlers({
            server: fakeServer(),
            logger: fakeLogger(),
            onSignal: (signal) => {
                registered.push(signal);
            },
        });
        // SIGTERM is Cloud Run's; SIGINT keeps local Ctrl-C on the same path.
        expect(registered).toEqual(['SIGTERM', 'SIGINT']);
    });

    it('closes idle keep-alive connections so a drain is not held open by them', () => {
        const server = fakeServer();
        const shutdown = installShutdownHandlers({ server, logger: fakeLogger() });

        shutdown('SIGTERM');

        // Without this, `close()` waits on sockets that will never send another
        // byte, and every shutdown takes the full grace period.
        expect(server.idleCalls).toBe(1);
        expect(server.closeCalls).toBe(1);
        // In-flight connections are left alone while there is still time.
        expect(server.allCalls).toBe(0);
    });

    it('exits 0 as soon as in-flight requests finish, without waiting out the grace period', () => {
        const exit = vi.fn();
        const server = fakeServer();
        const shutdown = installShutdownHandlers({ server, logger: fakeLogger(), exit });

        shutdown('SIGTERM');
        expect(exit).not.toHaveBeenCalled();

        server.finishDrain();
        expect(exit).toHaveBeenCalledExactlyOnceWith(0);

        // The forced-exit timer must not fire afterwards and exit a second time.
        vi.advanceTimersByTime(SHUTDOWN_GRACE_MS * 2);
        expect(exit).toHaveBeenCalledTimes(1);
    });

    it('forces exit when the drain outlasts the grace period', () => {
        const exit = vi.fn();
        const server = fakeServer();
        const shutdown = installShutdownHandlers({
            server,
            logger: fakeLogger(),
            graceMs: 1_000,
            exit,
        });

        shutdown('SIGTERM');
        vi.advanceTimersByTime(999);
        expect(exit).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        // Still exit 0: an expired drain is a deadline, not a crash. The point is
        // that the exit is ours and logged rather than a platform SIGKILL.
        expect(exit).toHaveBeenCalledExactlyOnceWith(0);
        // Only now are mid-request sockets dropped.
        expect(server.allCalls).toBe(1);
    });

    it('warns when it force-exits, so a chronically slow drain is visible in logs', () => {
        const logger = fakeLogger();
        const shutdown = installShutdownHandlers({
            server: fakeServer(),
            logger,
            graceMs: 1_000,
            exit: vi.fn(),
        });

        shutdown('SIGTERM');
        vi.advanceTimersByTime(1_000);

        expect(logger.warn).toHaveBeenCalledOnce();
    });

    it('ignores a repeat signal so a second drain cannot force-exit the first', () => {
        const exit = vi.fn();
        const server = fakeServer();
        const shutdown = installShutdownHandlers({
            server,
            logger: fakeLogger(),
            graceMs: 1_000,
            exit,
        });

        shutdown('SIGTERM');
        shutdown('SIGTERM');

        // One drain, not two — a second `close()` would restart the clock.
        expect(server.closeCalls).toBe(1);

        server.finishDrain();
        expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    });

    it('exits non-zero when close reports an error', () => {
        const exit = vi.fn();
        const logger = fakeLogger();
        const server = fakeServer();
        const shutdown = installShutdownHandlers({ server, logger, exit });

        shutdown('SIGTERM');
        // `close` errors when the server was not listening — a broken assumption
        // about state, not a drain that ran out of time.
        server.finishDrain(new Error('Server is not running.'));

        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(logger.error).toHaveBeenCalledOnce();
    });

    it('tolerates a server lacking the optional connection-management methods', () => {
        const exit = vi.fn();
        let pending: ((err?: Error) => void) | undefined;
        // http2 servers expose `close` but neither `closeIdleConnections` nor
        // `closeAllConnections`; `serve()`'s return type admits them, so the
        // optional calls must not throw.
        const minimal: ClosableServer = {
            close(callback) {
                pending = callback;
            },
        };

        const shutdown = installShutdownHandlers({ server: minimal, logger: fakeLogger(), exit });
        expect(() => shutdown('SIGTERM')).not.toThrow();

        pending?.();
        expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    });
});
