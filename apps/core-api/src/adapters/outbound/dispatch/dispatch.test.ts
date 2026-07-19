import { describe, it, expect, vi } from 'vitest';
import type { AudioProcessingDependencies } from '@antiphony/core/ports/audio-processing-dependencies';
import type { ProcessingProviders } from '@antiphony/core/services/audio-processing';
import type { Logger } from '@antiphony/core/ports/logger';
import { inlineDispatcher } from './inline.js';
import { noopDispatcher } from './noop.js';

/**
 * Dispatcher adapters (step 8).
 *
 * These assert the SEAM, not the processing run: that inline actually reaches
 * the service with the job's identifiers, and that neither adapter quietly
 * absorbs a failure the dispatch site is supposed to see. The processing
 * behavior itself is covered by the service's own suite.
 */

/**
 * Minimal deps stub. `process()` returns early when the post is missing, so a
 * `getPostById` that yields nothing is enough to drive a complete, side-effect
 * free run — the point here is that the call arrives with the right arguments.
 */
function depsStub(getPostById = vi.fn(async () => null)): {
    deps: AudioProcessingDependencies;
    getPostById: typeof getPostById;
} {
    return {
        deps: {
            getPostById,
            // The service claims a lease before touching anything, so an
            // uncontended stub is the minimum for the run to reach the post.
            claimProcessingLease: vi.fn(async () => true),
            releaseProcessingLease: vi.fn(async () => undefined),
            now: vi.fn(() => new Date(0)),
        } as unknown as AudioProcessingDependencies,
        getPostById,
    };
}

function loggerStub(): Logger & { warn: ReturnType<typeof vi.fn> } {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

describe('inlineDispatcher', () => {
    it('runs the job against the service with the job tenant and post', async () => {
        const { deps, getPostById } = depsStub();

        await inlineDispatcher(deps, {} as ProcessingProviders, loggerStub()).dispatch({
            originAppId: 'app-1',
            postId: 'post-1',
        });

        // Tenant must travel in the job — the worker has no ambient request
        // context to inherit it from, and every storage read is tenant-scoped.
        expect(getPostById).toHaveBeenCalledWith('app-1', 'post-1');
    });

    it('propagates a failure rather than swallowing it', async () => {
        // The port's contract: a dispatcher does not absorb its own failures.
        // If this ever starts resolving, `dispatchProcessing` logs nothing and
        // a broken processing run becomes indistinguishable from a clean one.
        const boom = vi.fn(async () => {
            throw new Error('storage down');
        });
        const { deps } = depsStub(boom as never);

        await expect(
            inlineDispatcher(deps, {} as ProcessingProviders, loggerStub()).dispatch({
                originAppId: 'app-1',
                postId: 'post-1',
            }),
        ).rejects.toThrow('storage down');
    });

    it('routes the service’s own warnings through the injected logger', async () => {
        // The service defaults to `defaultLogger` (console), and its warnings
        // are the stranded-artifact paths — the only record that a post serves
        // an artifact for audio that no longer exists. Under console those lose
        // pino's JSON shape and arrive in Cloud Logging unparsed, with no
        // severity and no requestId. Drive a real stranded case and assert the
        // line lands on the injected logger.
        const logger = loggerStub();
        const post = {
            embed: { audio: { ref: { $link: 'bafkreiaudio' } } },
            // The chain-stranded branch needs BOTH: a runnable pending link to
            // set the restart point (`denoise`, with a denoiser wired below),
            // and a later `ready` link the rebuilt chain would re-apply but
            // cannot (`trim`, with no trimmer). The variant then ends up
            // missing trim while the state still reads `ready` — the case the
            // log line exists to record.
            processing: { denoise: 'pending', trim: 'ready', processedBlobCid: 'bafkreivariant' },
        };
        const deps = {
            getPostById: vi.fn(async () => post),
            readBlobBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
            patchProcessingState: vi.fn(async () => undefined),
            writeDerivedBlob: vi.fn(async () => 'bafkreinew'),
            now: vi.fn(() => new Date(0)),
            claimProcessingLease: vi.fn(async () => true),
            releaseProcessingLease: vi.fn(async () => undefined),
        } as unknown as AudioProcessingDependencies;

        // Passthrough denoiser — in-memory, no external call and nothing billed.
        const providers = {
            denoiser: { denoise: async (i: { bytes: Uint8Array; mimeType: string }) => i },
        } as unknown as ProcessingProviders;

        await inlineDispatcher(deps, providers, logger).dispatch({
            originAppId: 'app-1',
            postId: 'post-1',
        });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ originAppId: 'app-1', postId: 'post-1' }),
            expect.stringContaining('[audio-processing]'),
        );
    });

    it('awaits the run, so results are visible when dispatch resolves', async () => {
        // This is the property the route tests depend on: a create in inline
        // mode can re-read the post and see settled stages. A dispatcher that
        // returned before the run finished would make those tests flaky
        // rather than failing outright.
        let finished = false;
        const slow = vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 10));
            finished = true;
            return null;
        });
        const { deps } = depsStub(slow as never);

        await inlineDispatcher(deps, {} as ProcessingProviders, loggerStub()).dispatch({
            originAppId: 'app-1',
            postId: 'post-1',
        });

        expect(finished).toBe(true);
    });
});

describe('noopDispatcher', () => {
    it('resolves without throwing', async () => {
        await expect(
            noopDispatcher(loggerStub()).dispatch({ originAppId: 'app-1', postId: 'post-1' }),
        ).resolves.toBeUndefined();
    });

    it('logs the dropped job with enough context to identify the post', async () => {
        // The symptom of this misconfiguration is a post stuck `pending` with
        // nothing in its own record explaining why, so the log line is the
        // only place the reason exists. Both identifiers are needed to find it.
        const logger = loggerStub();

        await noopDispatcher(logger).dispatch({ originAppId: 'app-1', postId: 'post-1' });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ postId: 'post-1', originAppId: 'app-1' }),
            expect.stringContaining('no dispatcher configured'),
        );
    });
});
