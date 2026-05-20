import { describe, it, expect, vi } from 'vitest';
import { HydrationService } from './hydration';
import type { HydrationDependencies } from '../ports/hydration-dependencies';
import { PromptDocumentSchema } from 'shared/types/storage';
import type { ProfileView, ReplyRecord } from 'shared/types';

/**
 * Focused tests for the prompt-doc → PromptView derivation of analytics
 * aggregates (Phase 4). The `engagementScoreSum / Count` and
 * `sentimentCounts` fields on the doc are maintained by the enrichment
 * trigger + status-flip path (see replies-dependencies.test.ts). Hydration's
 * job is the read-side conversion: average-or-null and pass-through.
 */

function makeAuthor(): ProfileView {
    return {
        id: 'author-1',
        handle: 'alice',
        username: 'alice',
        displayName: 'Alice',
        photoUrl: null,
        bio: null,
        stats: { followers: 0, following: 0, prompts: 0 },
        unreadReplyCount: 0,
        newReplierCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
    } as unknown as ProfileView;
}

function makePromptDoc(overrides: Record<string, unknown> = {}) {
    return PromptDocumentSchema.parse({
        id: 'p-1',
        authorId: 'author-1',
        title: 'A test prompt',
        audioUrl: 'https://example.com/a.mp3',
        createdAt: new Date(),
        status: 'live',
        ...overrides,
    });
}

function buildService(): HydrationService {
    const deps: HydrationDependencies = {
        loadUser: vi.fn(async () => makeAuthor()),
        loadPrompt: vi.fn(),
        countOrgMembers: vi.fn(),
        getOrgMemberRole: vi.fn(),
        getOrgName: vi.fn(),
        getUsersByIds: vi.fn(),
        getReplyEnrichmentsByIds: vi.fn(async () => new Map()),
    };
    return new HydrationService(deps);
}

describe('HydrationService.hydratePrompt — analytics aggregates', () => {
    it('returns avgEngagementScore = sum / count when at least one enriched live reply exists', async () => {
        const doc = makePromptDoc({
            engagementScoreSum: 21,
            engagementScoreCount: 3, // 21/3 = 7
            sentimentCounts: { positive: 2, neutral: 1, negative: 0 },
        });
        const svc = buildService();

        const view = await svc.hydratePrompt(doc);

        expect(view.analytics?.avgEngagementScore).toBe(7);
        expect(view.analytics?.sentimentBreakdown).toEqual({
            positive: 2,
            neutral: 1,
            negative: 0,
        });
    });

    it('returns avgEngagementScore = null when no enriched live replies have been counted', async () => {
        // Default doc: aggregates all zero (schema default).
        const doc = makePromptDoc();
        const svc = buildService();

        const view = await svc.hydratePrompt(doc);

        // null (not 0) — 0 is a valid bottom-of-range score and would mislead
        // the UI into rendering "0 engagement" instead of "no data".
        expect(view.analytics?.avgEngagementScore).toBeNull();
        expect(view.analytics?.sentimentBreakdown).toEqual({
            positive: 0,
            neutral: 0,
            negative: 0,
        });
    });

    it('passes sentimentBreakdown through verbatim from the prompt doc', async () => {
        const doc = makePromptDoc({
            engagementScoreSum: 5,
            engagementScoreCount: 1,
            sentimentCounts: { positive: 0, neutral: 0, negative: 1 },
        });
        const svc = buildService();

        const view = await svc.hydratePrompt(doc);

        expect(view.analytics?.sentimentBreakdown).toEqual({
            positive: 0,
            neutral: 0,
            negative: 1,
        });
    });

    it('parses legacy prompt docs (no aggregate fields) using zero defaults — keeps null average', async () => {
        // Schema parses missing aggregate fields to zero defaults; hydration
        // sees count=0 and produces null. This is what unbackfilled prod docs
        // look like immediately after PR 1 deploys, before the backfill runs.
        const doc = PromptDocumentSchema.parse({
            id: 'p-legacy',
            authorId: 'author-1',
            title: 'Legacy prompt',
            audioUrl: 'https://example.com/a.mp3',
            createdAt: new Date(),
            status: 'live',
            // engagementScoreSum, engagementScoreCount, sentimentCounts NOT set
        });
        const svc = buildService();

        const view = await svc.hydratePrompt(doc);

        expect(view.analytics?.avgEngagementScore).toBeNull();
        expect(view.analytics?.sentimentBreakdown).toEqual({
            positive: 0,
            neutral: 0,
            negative: 0,
        });
    });

    it('produces a fractional average when sum is not divisible by count', async () => {
        const doc = makePromptDoc({
            engagementScoreSum: 10,
            engagementScoreCount: 3, // 10/3 = 3.333...
            sentimentCounts: { positive: 1, neutral: 1, negative: 1 },
        });
        const svc = buildService();

        const view = await svc.hydratePrompt(doc);

        expect(view.analytics?.avgEngagementScore).toBeCloseTo(10 / 3, 10);
    });
});

describe('HydrationService.hydrateReplies — batch user loading', () => {
    const makeReply = (overrides: Partial<ReplyRecord> = {}): ReplyRecord => {
        return {
            id: 'r-1',
            promptId: 'p-1',
            authorId: 'author-1',
            audioUrl: 'https://example.com/r.mp3',
            status: 'live',
            createdAt: new Date(),
            ...overrides,
        } as ReplyRecord;
    };

    const makeRecipient = (): ProfileView => {
        return {
            id: 'recipient-1',
            handle: 'bob',
            username: 'bob',
            displayName: 'Bob',
            photoUrl: null,
            bio: null,
            stats: { followers: 0, following: 0, prompts: 0 },
            unreadReplyCount: 0,
            newReplierCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
        } as unknown as ProfileView;
    };

    it('always batch-fetches user profiles via getUsersByIds even when includePrivateData is false', async () => {
        const records = [
            makeReply({ id: 'r-1', authorId: 'user-a' }),
            makeReply({ id: 'r-2', authorId: 'user-b' }),
        ];
        const recipient = makeRecipient();

        const mockUsers = [
            { id: 'user-a', displayName: 'User A' } as ProfileView,
            { id: 'user-b', displayName: 'User B' } as ProfileView,
        ];

        const loadUserSpy = vi.fn();
        const getUsersByIdsSpy = vi.fn(async () => mockUsers);

        const deps: HydrationDependencies = {
            loadUser: loadUserSpy,
            loadPrompt: vi.fn(),
            countOrgMembers: vi.fn(),
            getOrgMemberRole: vi.fn(),
            getOrgName: vi.fn(),
            getUsersByIds: getUsersByIdsSpy,
            getReplyEnrichmentsByIds: vi.fn(async () => new Map()),
        };
        const svc = new HydrationService(deps);

        const views = await svc.hydrateRepliesWithRecipient(records, recipient, { includePrivateData: false });

        expect(views).toHaveLength(2);
        expect(getUsersByIdsSpy).toHaveBeenCalledOnce();
        expect(getUsersByIdsSpy).toHaveBeenCalledWith(['user-a', 'user-b'], { includePrivateData: false });
        expect(loadUserSpy).not.toHaveBeenCalled(); // Ensuring loadUser N+1 loop was bypassed!
        expect(views[0].author.displayName).toBe('User A');
        expect(views[1].author.displayName).toBe('User B');
    });

    it('batch-fetches user profiles with includePrivateData: true and fetches enrichments', async () => {
        const records = [
            makeReply({ id: 'r-1', authorId: 'user-a' }),
        ];
        const recipient = makeRecipient();

        const mockUsers = [
            { id: 'user-a', displayName: 'User A' } as ProfileView,
        ];

        const loadUserSpy = vi.fn();
        const getUsersByIdsSpy = vi.fn(async () => mockUsers);
        const getReplyEnrichmentsByIdsSpy = vi.fn(async () => new Map([['r-1', { notes: 'Some private notes' }]]));

        const deps: HydrationDependencies = {
            loadUser: loadUserSpy,
            loadPrompt: vi.fn(),
            countOrgMembers: vi.fn(),
            getOrgMemberRole: vi.fn(),
            getOrgName: vi.fn(),
            getUsersByIds: getUsersByIdsSpy,
            getReplyEnrichmentsByIds: getReplyEnrichmentsByIdsSpy,
        };
        const svc = new HydrationService(deps);

        const views = await svc.hydrateRepliesWithRecipient(records, recipient, { includePrivateData: true });

        expect(views).toHaveLength(1);
        expect(getUsersByIdsSpy).toHaveBeenCalledOnce();
        expect(getUsersByIdsSpy).toHaveBeenCalledWith(['user-a'], { includePrivateData: true });
        expect(getReplyEnrichmentsByIdsSpy).toHaveBeenCalledOnce();
        expect(getReplyEnrichmentsByIdsSpy).toHaveBeenCalledWith(['r-1']);
        expect(loadUserSpy).not.toHaveBeenCalled();
        expect(views[0].notes).toBe('Some private notes');
    });

    it('deduplicates author IDs before calling getUsersByIds', async () => {
        const records = [
            makeReply({ id: 'r-1', authorId: 'user-a' }),
            makeReply({ id: 'r-2', authorId: 'user-b' }),
            makeReply({ id: 'r-3', authorId: 'user-a' }),
        ];
        const recipient = makeRecipient();

        const mockUsers = [
            { id: 'user-a', displayName: 'User A' } as ProfileView,
            { id: 'user-b', displayName: 'User B' } as ProfileView,
        ];

        const loadUserSpy = vi.fn();
        const getUsersByIdsSpy = vi.fn(async () => mockUsers);

        const deps: HydrationDependencies = {
            loadUser: loadUserSpy,
            loadPrompt: vi.fn(),
            countOrgMembers: vi.fn(),
            getOrgMemberRole: vi.fn(),
            getOrgName: vi.fn(),
            getUsersByIds: getUsersByIdsSpy,
            getReplyEnrichmentsByIds: vi.fn(async () => new Map()),
        };
        const svc = new HydrationService(deps);

        const views = await svc.hydrateRepliesWithRecipient(records, recipient);

        expect(views).toHaveLength(3);
        expect(getUsersByIdsSpy).toHaveBeenCalledOnce();
        const calledIds = getUsersByIdsSpy.mock.calls[0][0];
        expect(calledIds).toHaveLength(2);
        expect(calledIds).toContain('user-a');
        expect(calledIds).toContain('user-b');
        expect(loadUserSpy).not.toHaveBeenCalled();
    });

    it('prevents sequential fallback loadUser calls when preloaded author profile is missing (deleted user)', async () => {
        const records = [
            makeReply({ id: 'r-1', authorId: 'missing-user' }),
        ];
        const recipient = makeRecipient();

        const loadUserSpy = vi.fn();
        // Return an empty list, meaning preloaded author profile was not found
        const getUsersByIdsSpy = vi.fn(async () => []);

        const deps: HydrationDependencies = {
            loadUser: loadUserSpy,
            loadPrompt: vi.fn(),
            countOrgMembers: vi.fn(),
            getOrgMemberRole: vi.fn(),
            getOrgName: vi.fn(),
            getUsersByIds: getUsersByIdsSpy,
            getReplyEnrichmentsByIds: vi.fn(async () => new Map()),
        };
        const svc = new HydrationService(deps);

        const views = await svc.hydrateRepliesWithRecipient(records, recipient);

        expect(views).toHaveLength(1);
        expect(getUsersByIdsSpy).toHaveBeenCalledOnce();
        expect(loadUserSpy).not.toHaveBeenCalled(); // Ensuring loadUser was NOT called for missing user!
        expect(views[0].author.displayName).toBe('Unknown User'); // Bounced to fallback synthetic stub safely
    });
});

