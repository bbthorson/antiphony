import { describe, it, expect } from 'vitest';
import { toProfileViewBasic } from './views';

describe('toProfileViewBasic', () => {
    // A fully-populated admin-shaped profile: every PII / admin field set so we
    // can assert exactly which survive the public projection and which are
    // stripped. Mirrors what `parseProfileFromDoc` produces off a Firestore doc.
    function fullAdminProfile(overrides: Record<string, unknown> = {}) {
        return {
            id: 'u1',
            handle: 'alice',
            displayName: 'Alice',
            avatarUrl: 'https://example.com/a.png',
            bio: 'hello',
            website: 'https://alice.example',
            links: [{ label: 'site', url: 'https://alice.example' }],
            bluesky: { handle: 'alice.bsky.social', did: 'did:plc:abc' },
            showBlueskyPublicly: true,
            stats: { followers: 1, following: 2, prompts: 3 },
            badges: ['founder'],
            isVerified: true,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            // PII / admin fields — none of these may cross the public boundary.
            email: 'alice@example.com',
            phoneNumber: '+15551234567',
            lastSeenAt: new Date('2026-06-01T00:00:00Z'),
            unreadReplyCount: 7,
            newReplierCount: 2,
            settings: { notifications: true, theme: 'dark' },
            blockedUsers: ['u2'],
            followers: ['u3'],
            following: ['u4'],
            reportCount: 1,
            isBanned: false,
            tier: 'creator_pro',
            ...overrides,
        };
    }

    it('strips PII and admin fields', () => {
        const out = toProfileViewBasic(fullAdminProfile()) as Record<string, unknown>;
        for (const k of [
            'email', 'phoneNumber', 'lastSeenAt', 'unreadReplyCount', 'newReplierCount',
            'settings', 'blockedUsers', 'reportCount', 'isBanned', 'tier',
        ]) {
            expect(out[k]).toBeUndefined();
        }
    });

    it('preserves the public surface', () => {
        const out = toProfileViewBasic(fullAdminProfile());
        expect(out.id).toBe('u1');
        expect(out.handle).toBe('alice');
        expect(out.displayName).toBe('Alice');
        expect(out.bio).toBe('hello');
        expect(out.website).toBe('https://alice.example');
        expect(out.links).toEqual([{ label: 'site', url: 'https://alice.example' }]);
    });

    it('gates the Bluesky identity on showBlueskyPublicly', () => {
        const optedIn = toProfileViewBasic(fullAdminProfile({ showBlueskyPublicly: true }));
        expect(optedIn.bluesky).toEqual({ handle: 'alice.bsky.social', did: 'did:plc:abc' });

        const optedOut = toProfileViewBasic(fullAdminProfile({ showBlueskyPublicly: false }));
        expect(optedOut.bluesky).toBeUndefined();

        const absent = toProfileViewBasic(fullAdminProfile({ showBlueskyPublicly: undefined }));
        expect(absent.bluesky).toBeUndefined();
    });
});
