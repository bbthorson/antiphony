import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Queue worker route (step 8).
 *
 * The subject here is the STATUS CODE, because to Cloud Tasks a status code is
 * not a description of what happened — it is an instruction about whether to
 * run the work again. Getting it backwards re-bills ElevenLabs for a stage that
 * already failed, or abandons a post over a Firestore blip. Neither is visible
 * from inside the process; both are permanent.
 */

const process_ = vi.fn(async () => undefined);
vi.mock('@antiphony/core/services/audio-processing', () => ({
    AudioProcessingService: class {
        process = process_;
    },
}));

vi.mock('../../outbound/firebase/audio-processing-dependencies.js', () => ({
    firebaseAudioProcessingDependencies: {},
}));

vi.mock('../../../lib/audio-processing.js', () => ({
    resolveProviders: () => ({}),
}));

const SYSTEM_TOKEN = 'sys-tok-abcdefghijklmnopqrstuvwxyz01234';
process.env.SYSTEM_AUTH_TOKEN = SYSTEM_TOKEN;
process.env.LOG_LEVEL = 'silent';

const { systemProcessAudioRoute } = await import('./system-process-audio.js');

function post(body: unknown, token: string | null = SYSTEM_TOKEN) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return systemProcessAudioRoute.request('/', {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

describe('POST /system/process-audio', () => {
    beforeEach(() => {
        process_.mockReset();
        process_.mockResolvedValue(undefined);
    });

    it('runs the job for the payload tenant and post', async () => {
        const res = await post({ originAppId: 'vox-pop', postId: 'p1' });

        expect(res.status).toBe(200);
        // Tenant travels in the job: the worker runs outside the originating
        // request and has no ambient context to inherit it from.
        expect(process_).toHaveBeenCalledWith('vox-pop', 'p1');
    });

    it('requires system auth', async () => {
        // An open worker would let anyone drive billable ElevenLabs calls
        // against any post id they can guess.
        expect((await post({ originAppId: 'vox-pop', postId: 'p1' }, null)).status).toBe(401);
        expect((await post({ originAppId: 'vox-pop', postId: 'p1' }, 'wrong-token')).status).toBe(
            401,
        );
        expect(process_).not.toHaveBeenCalled();
    });

    it('returns 503 when the pass throws, so the queue retries', async () => {
        // The ONLY retryable case. An error escaping `process()` came from
        // outside a stage's own try/catch — Firestore unreachable, storage down
        // — so nothing was recorded and a retry is what recovers it.
        process_.mockRejectedValue(new Error('firestore down'));

        expect((await post({ originAppId: 'vox-pop', postId: 'p1' })).status).toBe(503);
    });

    it('returns 200 when the pass completes, even with stages settled failed', async () => {
        // A failed stage is already recorded in the post's state, and
        // `process()` acts only on `pending` — so a redelivery would re-read
        // that state and do nothing. The retry cannot help and the attempt that
        // failed already cost money. `process()` resolving IS that signal.
        process_.mockResolvedValue(undefined);

        expect((await post({ originAppId: 'vox-pop', postId: 'p1' })).status).toBe(200);
    });

    it('returns 200 on a malformed payload rather than retrying bad bytes', async () => {
        // Not transient. Retrying replays the same bad bytes on the queue's
        // backoff schedule until it gives up.
        const badJson = await post('{not json');
        expect(badJson.status).toBe(200);
        expect(await badJson.json()).toMatchObject({ data: { ran: false } });

        const missingField = await post({ originAppId: 'vox-pop' });
        expect(missingField.status).toBe(200);
        expect(await missingField.json()).toMatchObject({ data: { ran: false } });

        // And it must not have been treated as a job.
        expect(process_).not.toHaveBeenCalled();
    });

    it('reports whether work ran, so a 200 is not ambiguous in the logs', async () => {
        const res = await post({ originAppId: 'vox-pop', postId: 'p1' });

        expect(await res.json()).toMatchObject({ success: true, data: { ran: true } });
    });
});
