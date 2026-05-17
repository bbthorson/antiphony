import { describe, it, expect, vi } from 'vitest';
import { HydrationService } from './hydration';
import type { HydrationDependencies } from '../ports/hydration-dependencies';
import { PromptDocumentSchema } from 'shared/types/storage';
import type { ProfileView } from 'shared/types';

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
