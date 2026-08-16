import { describe, it, expect, vi } from 'vitest';
import { queueDispatcher, queueResolver } from './queue.js';
import type { Logger } from '@antiphony/core/ports/logger';

const loggerStub = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('queueDispatcher', () => {
    it('sends exactly the two job identifiers', async () => {
        // The payload is deliberately not the post record and not a stage list.
        // Stored `processing` state is authoritative, and a PATCH landing
        // between dispatch and execution has to win — a payload carrying its
        // own plan would run one the caller has already replaced. See
        // ports/processing-dispatch.ts.
        const send = vi.fn(async () => undefined);

        await queueDispatcher({ send }, loggerStub()).dispatch({
            originAppId: 'vox-pop',
            postId: 'p1',
        });

        expect(send).toHaveBeenCalledWith({ originAppId: 'vox-pop', postId: 'p1' });
    });

    it('rejects when the send fails, rather than swallowing', async () => {
        // The port's contract: a dispatcher that absorbed its own failures
        // would be indistinguishable from one that worked. `dispatchProcessing`
        // is what catches, because the post is already committed by then.
        const send = vi.fn(async () => {
            throw new Error('queue unavailable');
        });

        await expect(
            queueDispatcher({ send }, loggerStub()).dispatch({
                originAppId: 'vox-pop',
                postId: 'p1',
            }),
        ).rejects.toThrow('queue unavailable');
    });
});

describe('queueResolver', () => {
    it('wires a dispatcher when the binding is present', () => {
        const resolve = queueResolver(loggerStub());
        expect(resolve({ PROCESSING_QUEUE: { send: async () => undefined } })).toBeDefined();
    });

    it('resolves to nothing without the binding, so the seam falls through to noop', () => {
        expect(queueResolver(loggerStub())({})).toBeUndefined();
        expect(queueResolver(loggerStub())(undefined)).toBeUndefined();
    });

    it('ignores a non-binding value in the queue slot', () => {
        // A string there means someone set a var where a binding belongs.
        // Building a dispatcher around it would fail later, at dispatch time,
        // inside a request that has already committed its post.
        expect(queueResolver(loggerStub())({ PROCESSING_QUEUE: 'antiphony-processing' })).toBeUndefined();
    });
});
