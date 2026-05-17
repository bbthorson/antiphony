import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PromptView, ReplyRecord, ReplyView, ProfileView } from 'shared/types';
import { ReplyService } from './replies';
import type { ReplyDependencies } from '../ports/replies-dependencies';
import type { CoreServices } from '../ports/core-services';

/**
 * Focused tests for the cross-prompt reply feed (`listReplyFeed`). The
 * filter pipeline + cursor pagination are net-new logic; we exercise them
 * end-to-end against an in-memory dep + service stub instead of mocking the
 * Firestore binding directly.
 */

const VIEWER_UID = 'viewer-1';

function makeUserProfile(): ProfileView {
    return {
        id: VIEWER_UID,
        handle: 'viewer',
        record: { id: VIEWER_UID, handle: 'viewer' },
    } as unknown as ProfileView;
}

function makeReplyRecord(overrides: Partial<ReplyRecord> & { id: string; promptId: string; createdAt: Date }): ReplyRecord {
    return {
        promptId: overrides.promptId,
        authorId: 'author-1',
        audioUrl: 'https://example.com/a.m4a',
        status: 'live',
        ...overrides,
    } as ReplyRecord;
}

function makeReplyView(record: ReplyRecord, opts?: { isRead?: boolean }): ReplyView {
    return {
        record,
        author: { id: record.authorId },
        recipient: { id: VIEWER_UID },
        isRead: opts?.isRead ?? false,
        isDeleted: false,
        readBy: [],
    } as unknown as ReplyView;
}

interface StubInputs {
    /**
     * Prompts the simulated `getPromptsForUser` returns — i.e. the truncated
     * recent-100 list. Test the >100-prompt bug by leaving older owned
     * prompts out of this and listing them in `unlistedOwnedPrompts` instead.
     */
    prompts: PromptView[];
    /**
     * Additional prompts owned by the viewer but NOT in `getPromptsForUser`'s
     * paginated response — simulates prompts beyond the 100-prompt window.
     * `getPromptRecord` resolves these by id (it's a direct doc read in
     * production), so the ownership-check path should still find them.
     */
    unlistedOwnedPrompts?: PromptView[];
    /** Replies are keyed by promptId — what queryByPromptIds returns. */
    repliesByPromptId: Map<string, ReplyRecord[]>;
}

function buildService(inputs: StubInputs) {
    const deps: ReplyDependencies = {
        queryByPromptId: vi.fn(),
        queryByPromptIds: vi.fn(async (promptIds: string[]) => {
            const out: ReplyRecord[] = [];
            for (const pid of promptIds) {
                const list = inputs.repliesByPromptId.get(pid) ?? [];
                out.push(...list);
            }
            return out;
        }),
        getReplyById: vi.fn(),
        getRepliesByIds: vi.fn(),
        updateReply: vi.fn(),
        bulkUpdateReplies: vi.fn(),
        updateReplyStatusWithAggregates: vi.fn(),
        bulkUpdateRepliesStatusWithAggregates: vi.fn(),
        markReplyRead: vi.fn(),
        bulkMarkRepliesRead: vi.fn(),
        newReplyId: vi.fn(() => 'new-id'),
        newActivityId: vi.fn(() => 'new-activity'),
        createReplyWithCounterIncrement: vi.fn(),
        now: vi.fn(() => new Date()),
    } as unknown as ReplyDependencies;

    const services = {
        users: {
            getUserDataByUid: vi.fn(async (uid: string) =>
                uid === VIEWER_UID ? makeUserProfile() : null,
            ),
        },
        prompts: {
            getPromptsForUser: vi.fn(async () => inputs.prompts),
            // Used by loadAndFilterReplies's promptId-ownership-check path:
            // bypasses the truncated `getPromptsForUser` list and resolves
            // the prompt directly. Searches both `prompts` and the explicit
            // `unlistedOwnedPrompts` so tests can simulate the >100-prompt
            // bug scenario (owned, but not in the paginated list).
            getPromptRecord: vi.fn(async (id: string) => {
                const all = [...inputs.prompts, ...(inputs.unlistedOwnedPrompts ?? [])];
                const p = all.find((x) => x.record.id === id);
                return p ? p.record : null;
            }),
        },
        hydration: {
            // Identity hydrator: pass records through as ReplyView with the
            // recipient already set. Sufficient for filter/cursor logic.
            hydrateRepliesWithRecipient: vi.fn(async (records: ReplyRecord[]) =>
                records.map((r) => makeReplyView(r)),
            ),
        },
    } as unknown as CoreServices;

    return new ReplyService(deps, services);
}

function makePromptView(
    id: string,
    overrides: { authorId?: string; status?: 'live' | 'archived' | 'deleted' } = {},
): PromptView {
    const authorId = overrides.authorId ?? VIEWER_UID;
    return {
        record: { id, authorId, status: overrides.status ?? 'live' },
        author: { id: authorId },
    } as unknown as PromptView;
}

describe('ReplyService.listReplyFeed', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns replies sorted reverse-chronologically across prompts', async () => {
        const day = 86400000;
        const t0 = Date.now();
        const replies = new Map<string, ReplyRecord[]>([
            ['p1', [
                makeReplyRecord({ id: 'r-old-p1', promptId: 'p1', createdAt: new Date(t0 - 5 * day) }),
                makeReplyRecord({ id: 'r-new-p1', promptId: 'p1', createdAt: new Date(t0 - 1 * day) }),
            ]],
            ['p2', [
                makeReplyRecord({ id: 'r-mid-p2', promptId: 'p2', createdAt: new Date(t0 - 3 * day) }),
            ]],
        ]);
        const svc = buildService({
            prompts: [makePromptView('p1'), makePromptView('p2')],
            repliesByPromptId: replies,
        });

        const result = await svc.listReplyFeed(VIEWER_UID);

        expect(result.replies.map((r) => r.record.id)).toEqual([
            'r-new-p1',
            'r-mid-p2',
            'r-old-p1',
        ]);
        expect(result.nextCursor).toBeNull();
    });

    it('paginates via opaque cursor; second page resumes after the last item', async () => {
        const day = 86400000;
        const t0 = Date.now();
        const replies = new Map<string, ReplyRecord[]>([
            ['p1', Array.from({ length: 5 }, (_, i) =>
                makeReplyRecord({
                    id: `r-${i}`,
                    promptId: 'p1',
                    createdAt: new Date(t0 - i * day),
                }),
            )],
        ]);
        const svc = buildService({
            prompts: [makePromptView('p1')],
            repliesByPromptId: replies,
        });

        const page1 = await svc.listReplyFeed(VIEWER_UID, undefined, { limit: 2 });
        expect(page1.replies.map((r) => r.record.id)).toEqual(['r-0', 'r-1']);
        expect(page1.nextCursor).toBeTruthy();

        const page2 = await svc.listReplyFeed(VIEWER_UID, undefined, { limit: 2, cursor: page1.nextCursor });
        expect(page2.replies.map((r) => r.record.id)).toEqual(['r-2', 'r-3']);
        expect(page2.nextCursor).toBeTruthy();

        const page3 = await svc.listReplyFeed(VIEWER_UID, undefined, { limit: 2, cursor: page2.nextCursor });
        expect(page3.replies.map((r) => r.record.id)).toEqual(['r-4']);
        expect(page3.nextCursor).toBeNull();
    });

    it('treats malformed cursor as start-of-feed instead of erroring', async () => {
        const t0 = Date.now();
        const replies = new Map<string, ReplyRecord[]>([
            ['p1', [
                makeReplyRecord({ id: 'r-a', promptId: 'p1', createdAt: new Date(t0) }),
            ]],
        ]);
        const svc = buildService({
            prompts: [makePromptView('p1')],
            repliesByPromptId: replies,
        });

        const result = await svc.listReplyFeed(VIEWER_UID, undefined, { cursor: 'garbage!!!' });
        expect(result.replies.map((r) => r.record.id)).toEqual(['r-a']);
    });

    it('clamps limit into [1, 100]', async () => {
        const t0 = Date.now();
        const replies = new Map<string, ReplyRecord[]>([
            ['p1', Array.from({ length: 3 }, (_, i) =>
                makeReplyRecord({
                    id: `r-${i}`,
                    promptId: 'p1',
                    createdAt: new Date(t0 - i * 1000),
                }),
            )],
        ]);
        const svc = buildService({
            prompts: [makePromptView('p1')],
            repliesByPromptId: replies,
        });

        const zero = await svc.listReplyFeed(VIEWER_UID, undefined, { limit: 0 });
        expect(zero.replies).toHaveLength(1);

        const huge = await svc.listReplyFeed(VIEWER_UID, undefined, { limit: 9999 });
        expect(huge.replies).toHaveLength(3);
    });

    it('scopes by promptId filter', async () => {
        const t0 = Date.now();
        const replies = new Map<string, ReplyRecord[]>([
            ['p1', [makeReplyRecord({ id: 'r-p1', promptId: 'p1', createdAt: new Date(t0) })]],
            ['p2', [makeReplyRecord({ id: 'r-p2', promptId: 'p2', createdAt: new Date(t0) })]],
        ]);
        const svc = buildService({
            prompts: [makePromptView('p1'), makePromptView('p2')],
            repliesByPromptId: replies,
        });

        const result = await svc.listReplyFeed(VIEWER_UID, { promptId: 'p2' });
        expect(result.replies.map((r) => r.record.id)).toEqual(['r-p2']);
    });

    it('returns empty page when filtered prompt does not exist', async () => {
        const svc = buildService({
            prompts: [makePromptView('p1')],
            repliesByPromptId: new Map([
                ['p1', [makeReplyRecord({ id: 'r-1', promptId: 'p1', createdAt: new Date() })]],
            ]),
        });

        const result = await svc.listReplyFeed(VIEWER_UID, { promptId: 'p-not-mine' });
        expect(result.replies).toEqual([]);
        expect(result.nextCursor).toBeNull();
    });

    it('returns empty page when filtered prompt belongs to a different user', async () => {
        const foreign = makePromptView('p-foreign', { authorId: 'other-user' });
        const svc = buildService({
            // The viewer owns nothing; the foreign prompt is resolvable via
            // getPromptRecord but ownership-check rejects it.
            prompts: [],
            unlistedOwnedPrompts: [foreign],
            repliesByPromptId: new Map([
                ['p-foreign', [makeReplyRecord({
                    id: 'r-leak',
                    promptId: 'p-foreign',
                    createdAt: new Date(),
                })]],
            ]),
        });

        const result = await svc.listReplyFeed(VIEWER_UID, { promptId: 'p-foreign' });
        expect(result.replies).toEqual([]);
    });

    it('returns empty page when filtered prompt is soft-deleted', async () => {
        const deleted = makePromptView('p-gone', { status: 'deleted' });
        const svc = buildService({
            prompts: [],
            unlistedOwnedPrompts: [deleted],
            repliesByPromptId: new Map([
                ['p-gone', [makeReplyRecord({
                    id: 'r-gone',
                    promptId: 'p-gone',
                    createdAt: new Date(),
                })]],
            ]),
        });

        const result = await svc.listReplyFeed(VIEWER_UID, { promptId: 'p-gone' });
        expect(result.replies).toEqual([]);
    });

    it('resolves promptId even when it falls outside the recent-100 paginated list (regression)', async () => {
        // Simulates a power user with >100 prompts: their oldest prompt is
        // NOT in `getPromptsForUser`'s truncated list, but they still own it
        // and have replies on it. The ownership-check path must resolve it
        // via getPromptRecord, not filter-against-the-list.
        const t0 = Date.now();
        const recentPrompt = makePromptView('p-recent');
        const oldOwned = makePromptView('p-old-owned');
        const svc = buildService({
            prompts: [recentPrompt],
            unlistedOwnedPrompts: [oldOwned],
            repliesByPromptId: new Map([
                ['p-old-owned', [
                    makeReplyRecord({ id: 'r-old-a', promptId: 'p-old-owned', createdAt: new Date(t0 - 1000) }),
                    makeReplyRecord({ id: 'r-old-b', promptId: 'p-old-owned', createdAt: new Date(t0) }),
                ]],
            ]),
        });

        const result = await svc.listReplyFeed(VIEWER_UID, { promptId: 'p-old-owned' });
        expect(result.replies.map((r) => r.record.id)).toEqual(['r-old-b', 'r-old-a']);
    });
});

/**
 * Delegation tests for status-flip aggregate maintenance.
 *
 * The aggregate-delta rules (signed sums, sentiment bucket mapping, archived
 * ↔ deleted no-ops) live in `computeAggregateDelta` and are covered in
 * `replies-dependencies.test.ts`. These tests pin the service-layer contract:
 * `updateReplyStatus` / `bulkUpdateStatus` MUST delegate to the
 * aggregate-aware binding methods (passing prev-state) — not the legacy
 * `updateReply({ status })` / `bulkUpdateReplies({ status })` shortcut, which
 * would skip the prompt-doc aggregate maintenance.
 */
describe('ReplyService status flips delegate to aggregate-aware bindings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    function buildSvcWithReplies(replies: ReplyRecord[]): {
        svc: ReplyService;
        deps: ReplyDependencies;
    } {
        const ownerUid = VIEWER_UID;
        const replyById = new Map(replies.map((r) => [r.id, r]));
        const deps: ReplyDependencies = {
            queryByPromptId: vi.fn(),
            queryByPromptIds: vi.fn(),
            getReplyById: vi.fn(async (id: string) => replyById.get(id) ?? null),
            getRepliesByIds: vi.fn(async (ids: string[]) =>
                ids.map((id) => replyById.get(id) ?? null),
            ),
            updateReply: vi.fn(),
            bulkUpdateReplies: vi.fn(),
            updateReplyStatusWithAggregates: vi.fn(),
            bulkUpdateRepliesStatusWithAggregates: vi.fn(),
            markReplyRead: vi.fn(),
            bulkMarkRepliesRead: vi.fn(),
            newReplyId: vi.fn(),
            newActivityId: vi.fn(),
            createReplyWithCounterIncrement: vi.fn(),
            now: vi.fn(() => new Date()),
        };
        // Owner of every prompt referenced by the supplied replies.
        const promptOwnership = new Map<string, string>();
        for (const r of replies) {
            promptOwnership.set(r.promptId, ownerUid);
        }
        const services = {
            users: { getUserDataByUid: vi.fn(async () => makeUserProfile()) },
            prompts: {
                getPromptRecord: vi.fn(async (id: string) => {
                    const authorId = promptOwnership.get(id);
                    return authorId ? { id, authorId } : null;
                }),
                getPromptRecordsByIds: vi.fn(async (ids: string[]) =>
                    ids.map((id) => {
                        const authorId = promptOwnership.get(id);
                        return authorId ? { id, authorId } : null;
                    }),
                ),
            },
            hydration: {
                hydrateRepliesWithRecipient: vi.fn(),
            },
        } as unknown as CoreServices;
        return { svc: new ReplyService(deps, services), deps };
    }

    it('updateReplyStatus passes the loaded reply + new status to the aggregate-aware binding (not updateReply)', async () => {
        const reply: ReplyRecord = makeReplyRecord({
            id: 'r-x',
            promptId: 'p-x',
            createdAt: new Date(),
            sentiment: 'Positive',
            engagementScore: 8,
            aiStatus: 'complete',
        });
        const { svc, deps } = buildSvcWithReplies([reply]);

        await svc.updateReplyStatus('r-x', 'archived', VIEWER_UID);

        expect(deps.updateReplyStatusWithAggregates).toHaveBeenCalledTimes(1);
        expect(deps.updateReplyStatusWithAggregates).toHaveBeenCalledWith(reply, 'archived');
        // Legacy non-aggregate path must NOT be invoked — its use would drop
        // the parent prompt's aggregate sync.
        expect(deps.updateReply).not.toHaveBeenCalled();
    });

    it('bulkUpdateStatus passes the loaded replies (with prev state) to the bulk aggregate-aware binding', async () => {
        const r1 = makeReplyRecord({
            id: 'r-1', promptId: 'p-1', createdAt: new Date(),
            sentiment: 'Positive', engagementScore: 9, aiStatus: 'complete',
        });
        const r2 = makeReplyRecord({
            id: 'r-2', promptId: 'p-1', createdAt: new Date(),
            // No AI enrichment: binding skips this one's aggregate delta.
            aiStatus: 'pending',
        });
        const r3 = makeReplyRecord({
            id: 'r-3', promptId: 'p-2', createdAt: new Date(),
            sentiment: 'Negative', engagementScore: 2, aiStatus: 'complete',
        });
        const { svc, deps } = buildSvcWithReplies([r1, r2, r3]);

        await svc.bulkUpdateStatus(['r-1', 'r-2', 'r-3'], 'archived', VIEWER_UID);

        expect(deps.bulkUpdateRepliesStatusWithAggregates).toHaveBeenCalledTimes(1);
        const [passedReplies, passedStatus] =
            (deps.bulkUpdateRepliesStatusWithAggregates as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(passedStatus).toBe('archived');
        // Verify the binding receives the full prev records (not just IDs) so
        // it can compute deltas — and that ALL fetched replies pass through,
        // including those without enrichment (binding decides what counts).
        expect((passedReplies as ReplyRecord[]).map((r) => r.id).sort()).toEqual(['r-1', 'r-2', 'r-3']);
        expect(deps.bulkUpdateReplies).not.toHaveBeenCalled();
    });
});
