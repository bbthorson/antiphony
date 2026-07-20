import { describe, it, expect, vi } from 'vitest';
import { AudioProcessingService, type ProcessingProviders } from './audio-processing';
import type { AudioProcessingDependencies } from '../ports/audio-processing-dependencies';
import type { AudioPostRecord } from 'shared/types/audio';
import type { ProcessingState } from 'shared/types/processing';
import type {
    ProcessingNotifierPort,
    StageSettledEvent,
} from '../ports/processing-notifier';

/**
 * Stage-settled webhooks (`specs/enrichment-webhooks.md`), at the service seam.
 *
 * These pin the FIRE behaviour that every dispatcher inherits from `process()`:
 * one event per stage that reaches a terminal state, carrying exactly
 * `{postId, stage, status}`; a `pending` transition never fires; a rejected
 * `notify` never fails the pass. The HTTP + HMAC transport is covered by the
 * adapter's own suite — here the notifier is a fake that records events.
 */

const AUDIO_CID = 'bafkreioriginal';
const NOW = new Date('2026-07-03T00:00:00Z');

function makePost(processing: ProcessingState | undefined): AudioPostRecord {
    return {
        id: 'p1',
        cid: 'bafyreipost',
        originAppId: 'vox-pop',
        authorId: 'u1',
        kind: 'prompt',
        text: 'hi',
        embed: {
            $type: 'dev.antiphony.embed.audio',
            audio: { $type: 'blob', ref: { $link: AUDIO_CID }, mimeType: 'audio/webm', size: 2048 },
            durationMs: 4200,
        },
        createdAt: new Date('2026-07-03T00:00:00Z'),
        processing,
    } as AudioPostRecord;
}

function makeDeps(post: AudioPostRecord | null) {
    const patches: Array<Partial<Omit<ProcessingState, 'updatedAt'>>> = [];
    let derived = 0;
    const deps: AudioProcessingDependencies = {
        getPostById: vi.fn(async () => post),
        getAppDid: vi.fn((app: string) => `did:web:${app}.example`),
        readBlobBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
        writeDerivedBlob: vi.fn(async () => `bafkreiderived${derived++}`),
        saveTranscript: vi.fn(async () => undefined),
        patchProcessingState: vi.fn(async (_app, _id, patch) => { patches.push(patch); }),
        claimProcessingLease: vi.fn(async () => true),
        releaseProcessingLease: vi.fn(async () => undefined),
        newTranscriptId: vi.fn(() => 't1'),
        now: vi.fn(() => NOW),
    };
    return { deps, patches };
}

function providers(over: Partial<ProcessingProviders> = {}): ProcessingProviders {
    return {
        transcriber: { transcribe: vi.fn(async () => ({
            transcript: { segments: [{ startMs: 0, endMs: 4200, text: 'hi' }], text: 'hi' },
            lang: 'en',
            model: 'stub-1',
        })) },
        denoiser: { denoise: vi.fn(async () => ({ bytes: new Uint8Array([9, 9]), mimeType: 'audio/webm' })) },
        waveform: { waveform: vi.fn(async () => ({ peaks: [0, 50, 100] })) },
        ...over,
    };
}

function recordingNotifier() {
    const events: StageSettledEvent[] = [];
    const notifier: ProcessingNotifierPort = {
        notify: vi.fn(async (e: StageSettledEvent) => { events.push(e); }),
    };
    return { notifier, events };
}

describe('AudioProcessingService — stage-settled notifications', () => {
    it('fires exactly one event with {postId, stage, status} when a stage settles', async () => {
        const { deps } = makeDeps(makePost({ transcribe: 'pending', updatedAt: NOW }));
        const { notifier, events } = recordingNotifier();

        await new AudioProcessingService(deps, providers(), undefined, notifier).process('vox-pop', 'p1');

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            originAppId: 'vox-pop',
            postId: 'p1',
            stage: 'transcribe',
            status: 'ready',
            occurredAt: NOW.toISOString(),
        });
    });

    it('fires one event per terminal stage when a single patch settles several', async () => {
        // No denoiser/trimmer wired → both requested byte-mutating stages settle
        // `skipped` in ONE `patchProcessingState` call. The notifier must still
        // see one event per stage, not one per patch.
        const { deps } = makeDeps(makePost({ denoise: 'pending', trim: 'pending', updatedAt: NOW }));
        const { notifier, events } = recordingNotifier();

        await new AudioProcessingService(
            deps,
            providers({ denoiser: undefined }), // trimmer already absent from this providers()
            undefined,
            notifier,
        ).process('vox-pop', 'p1');

        const settled = events.map((e) => `${e.stage}:${e.status}`).sort();
        expect(settled).toEqual(['denoise:skipped', 'trim:skipped']);
    });

    it('does not fire for a pending transition (recompute marks derived pending, not settled)', async () => {
        // Denoise newly requested on a post that already carries a transcript:
        // recompute writes `transcribe: pending`, then re-runs it to `ready`.
        // The `pending` write must fire nothing; only the two `ready` settles do.
        const { deps } = makeDeps(makePost({ denoise: 'pending', transcribe: 'ready', updatedAt: NOW }));
        const { notifier, events } = recordingNotifier();

        await new AudioProcessingService(deps, providers(), undefined, notifier).process('vox-pop', 'p1');

        expect(events.some((e) => (e.status as string) === 'pending')).toBe(false);
        // The recompute's second, correct `ready` for transcribe IS an event.
        expect(events.filter((e) => e.stage === 'transcribe' && e.status === 'ready')).toHaveLength(1);
        expect(events.some((e) => e.stage === 'denoise' && e.status === 'ready')).toBe(true);
    });

    it('does not fail the pass when notify rejects — logs and swallows', async () => {
        const { deps, patches } = makeDeps(makePost({ transcribe: 'pending', updatedAt: NOW }));
        const notifier: ProcessingNotifierPort = {
            notify: vi.fn(async () => { throw new Error('receiver down'); }),
        };
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        const ran = await new AudioProcessingService(deps, providers(), logger, notifier).process('vox-pop', 'p1');

        // The stage still settled in Firestore, the pass still succeeded, and the
        // failure was logged rather than thrown.
        expect(ran).toBe(true);
        expect(patches).toContainEqual({ transcribe: 'ready' });
        expect(logger.error).toHaveBeenCalled();
        // Lease released even though notify threw inside the pass.
        expect(deps.releaseProcessingLease).toHaveBeenCalled();
    });

    it('fires nothing under the default (noop) notifier while still settling state', async () => {
        const { deps, patches } = makeDeps(makePost({ transcribe: 'pending', updatedAt: NOW }));

        // No notifier arg — the constructor default is the noop notifier.
        const ran = await new AudioProcessingService(deps, providers()).process('vox-pop', 'p1');

        expect(ran).toBe(true);
        expect(patches).toContainEqual({ transcribe: 'ready' });
    });
});
