import { describe, it, expect, vi } from 'vitest';
import type { ProfileView } from 'shared/types/views';
import { FeedService } from './feeds';
import type { CoreServices } from '../ports/core-services';
import { defaultLogger } from '../ports/logger';

/**
 * Security regression tests for the public profile endpoints (H1, June-2026
 * audit). `getUserProfileData` (GET /users/:handle/profile) and `resolveHandle`
 * (GET /resolve/:handle) are unauthenticated, so the profile they return MUST
 * be projected to the basic shape — `parseProfileFromDoc` builds the wide
 * admin shape off the Firestore doc, carrying email/phoneNumber/settings/etc.
 */

// Wide admin-shaped profile as produced by the user dependency layer — every
// PII / admin field populated so we can assert they never reach the wire.
function adminProfile(): ProfileView {
    return {
        id: 'u1',
        handle: 'alice',
        displayName: 'Alice',
        bio: 'hello',
        website: 'https://alice.example',
        bluesky: { handle: 'alice.bsky.social', did: 'did:plc:abc' },
        showBlueskyPublicly: true,
        email: 'alice@example.com',
        phoneNumber: '+15551234567',
        settings: { notifications: true },
        blockedUsers: ['u2'],
        unreadReplyCount: 5,
        newReplierCount: 1,
        tier: 'creator_pro',
        isBanned: false,
    } as unknown as ProfileView;
}

const PII_KEYS = [
    'email', 'phoneNumber', 'settings', 'blockedUsers',
    'unreadReplyCount', 'newReplierCount', 'tier', 'isBanned',
];

// A hydrated prompt whose nested author is the wide admin profile — mirrors
// production, where getPromptsForUser prefetches the owner via getUserDataByUid.
function adminAuthoredPrompt() {
    return {
        record: { id: 'p1', authorId: 'u1', title: 'P1', status: 'live' },
        author: adminProfile(),
        replyCount: 0,
        // Owner-only prompt enrichment that must not leak publicly.
        analytics: { views: 99 },
        aiSummary: 'private summary',
    };
}

function buildService(opts: { prompts?: unknown[] } = {}): FeedService {
    const services = {
        users: {
            getUserData: vi.fn(async () => adminProfile()),
            getUserDataByUid: vi.fn(async () => adminProfile()),
        },
        prompts: {
            getPromptsForUser: vi.fn(async () => opts.prompts ?? []),
        },
        organizations: {
            getOrganizationBySlug: vi.fn(async () => null),
        },
    } as unknown as CoreServices;
    return new FeedService(services, defaultLogger);
}

describe('FeedService public profile projection (H1)', () => {
    it('getUserProfileData strips PII/admin fields from profileUser', async () => {
        const data = await buildService().getUserProfileData('alice');
        expect(data).not.toBeNull();
        const profile = data!.profileUser as Record<string, unknown>;
        for (const k of PII_KEYS) expect(profile[k]).toBeUndefined();
        // Public fields survive.
        expect(profile.handle).toBe('alice');
        expect(profile.website).toBe('https://alice.example');
        // Bluesky preserved because the user opted in.
        expect(profile.bluesky).toEqual({ handle: 'alice.bsky.social', did: 'did:plc:abc' });
    });

    it('getUserProfileData strips PII from nested prompt authors and owner-only prompt fields', async () => {
        const data = await buildService({ prompts: [adminAuthoredPrompt()] }).getUserProfileData('alice');
        expect(data!.allPromptsWithReplies).toHaveLength(1);
        const prompt = data!.allPromptsWithReplies[0] as Record<string, unknown>;
        const author = prompt.author as Record<string, unknown>;
        for (const k of PII_KEYS) expect(author[k]).toBeUndefined();
        expect(author.handle).toBe('alice');
        // Owner-only prompt enrichment must be stripped too.
        expect(prompt.analytics).toBeUndefined();
        expect(prompt.aiSummary).toBeUndefined();
    });

    it('resolveHandle strips PII/admin fields from the user profile', async () => {
        const resolution = await buildService().resolveHandle('alice');
        expect(resolution?.type).toBe('user');
        const profile = (resolution as { profile: Record<string, unknown> }).profile;
        for (const k of PII_KEYS) expect(profile[k]).toBeUndefined();
        expect(profile.handle).toBe('alice');
    });
});
