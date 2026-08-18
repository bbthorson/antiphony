import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from './logger.js';

/**
 * The regression: `logger.error({ err }, '...')` emitted `"err":{}`.
 *
 * `JSON.stringify` drops an Error entirely — its properties are not enumerable —
 * so every error record in core-api carried a complete-looking line with no
 * error in it. It was found in production: a transcode failed from a Worker, the
 * log said `"err":{}`, and the status code that would have distinguished "wrong
 * credentials" from "object missing" was gone.
 */
function captured(fn: () => void): Record<string, unknown> {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fn();
    const line = spy.mock.calls[0]?.[0] as string;
    return JSON.parse(line);
}

afterEach(() => vi.restoreAllMocks());

describe('logger error serialisation', () => {
    it('keeps the message, which is the whole point', () => {
        const rec = captured(() => logger.error({ err: new Error('read failed (403)') }, 'boom'));
        expect((rec.err as Record<string, unknown>).message).toBe('read failed (403)');
    });

    it('keeps custom properties like a status code', () => {
        const err = Object.assign(new Error('nope'), { status: 403 });
        const rec = captured(() => logger.error({ err }, 'boom'));
        expect((rec.err as Record<string, unknown>).status).toBe(403);
    });

    it('keeps the stack', () => {
        const rec = captured(() => logger.error({ err: new Error('x') }, 'boom'));
        expect((rec.err as Record<string, unknown>).stack).toContain('Error: x');
    });

    it('handles an Error under any key, not just `err`', () => {
        const rec = captured(() => logger.warn({ cause: new Error('deep') }, 'boom'));
        expect((rec.cause as Record<string, unknown>).message).toBe('deep');
    });

    it('leaves ordinary context untouched', () => {
        const rec = captured(() => logger.info({ cid: 'abc', bytes: 12 }, 'fine'));
        expect(rec.cid).toBe('abc');
        expect(rec.bytes).toBe(12);
        expect(rec.msg).toBe('fine');
    });
});
