import { describe, it, expect } from 'vitest';
import { toReplyViewPublic, ReplyViewPublicSchema, toProfileViewBasic } from './views';
import type { ReplyView } from './views';

/**
 * Builds a fully-populated `ReplyView` for stripping-behavior tests. Every
 * private and public field is set so we can assert exactly which ones
 * survive and which get stripped.
 */
function fullReplyView(): ReplyView {
    return {
        record: {
            id: 'r1',
            promptId: 'p1',
            authorId: 'u1',
            audioUrl: 'https://example.com/audio.webm',
            createdAt: new Date('2026-05-25T00:00:00Z'),
            status: 'live',
            // Canonical-only fields (per spec § 5 — ingestion ffmpeg, not AI).
            waveformPeaks: [0.1, 0.5, 0.3],
            audioDurationSec: 12.5,
        },
        author: {
            id: 'u1',
            handle: 'replier',
            displayName: 'Replier',
        } as ReplyView['author'],
        recipient: {
            id: 'u-self',
            handle: 'self',
            displayName: 'Self',
        } as ReplyView['recipient'],
        isRead: false,
        isDeleted: false,
        readBy: [],
        // Lifted private fields (the strip targets)
        aiStatus: 'complete',
        aiError: undefined,
        aiSummary: 'A summary',
        aiLabels: ['music'],
        transcription: 'Hello world',         // public — stays
        sentiment: 'Positive',
        energyLevel: 'High',
        engagementScore: 8,
        enhancedAudioUrl: 'https://example.com/enhanced.webm', // public — stays
        enhancedStoragePath: '/audio/enhanced/r1.webm',
        socialVideoUrl: 'https://example.com/r1.mp4',
        socialVideoStoragePath: '/video/r1.mp4',
        socialVideoStatus: 'complete',
        socialVideoError: undefined,
        socialVideoSourceAudio: 'https://example.com/audio.webm',
        // CRM / PII strip targets
        listenerPhoneNumber: '+15551234567',
        notes: 'Private CRM note',
    } as ReplyView;
}

describe('toReplyViewPublic', () => {
    it('strips listenerPhoneNumber and notes (PII + CRM)', () => {
        const out = toReplyViewPublic(fullReplyView()) as Record<string, unknown>;
        expect(out.listenerPhoneNumber).toBeUndefined();
        expect(out.notes).toBeUndefined();
    });

    it('strips the entire private AI cluster (everything except transcription)', () => {
        const out = toReplyViewPublic(fullReplyView()) as Record<string, unknown>;
        // Private AI fields — must all be absent.
        expect(out.aiStatus).toBeUndefined();
        expect(out.aiError).toBeUndefined();
        expect(out.aiSummary).toBeUndefined();
        expect(out.aiLabels).toBeUndefined();
        expect(out.sentiment).toBeUndefined();
        expect(out.energyLevel).toBeUndefined();
        expect(out.engagementScore).toBeUndefined();
        // Public AI field — must survive.
        expect(out.transcription).toBe('Hello world');
    });

    it('strips voice-isolation storage path but keeps the public audio URL', () => {
        const out = toReplyViewPublic(fullReplyView()) as Record<string, unknown>;
        // Storage path is server-side bookkeeping — strip.
        expect(out.enhancedStoragePath).toBeUndefined();
        // Enhanced audio URL replaces canonical audio for downstream players — keep.
        expect(out.enhancedAudioUrl).toBe('https://example.com/enhanced.webm');
    });

    it('strips the entire social-video cluster (creator-only artifact)', () => {
        const out = toReplyViewPublic(fullReplyView()) as Record<string, unknown>;
        expect(out.socialVideoUrl).toBeUndefined();
        expect(out.socialVideoStoragePath).toBeUndefined();
        expect(out.socialVideoStatus).toBeUndefined();
        expect(out.socialVideoError).toBeUndefined();
        expect(out.socialVideoSourceAudio).toBeUndefined();
    });

    it('preserves the canonical record verbatim (no record-side stripping in this projection)', () => {
        // The projection strips lifted top-level fields; `record` is
        // passed through. Post Stage 4 the canonical record carries only
        // non-AI fields (audio refs + ffmpeg outputs), so verify those
        // survive intact.
        const out = toReplyViewPublic(fullReplyView());
        expect(out.record.id).toBe('r1');
        expect(out.record.audioUrl).toBe('https://example.com/audio.webm');
        expect(out.record.waveformPeaks).toEqual([0.1, 0.5, 0.3]);
        expect(out.record.audioDurationSec).toBe(12.5);
    });

    it('preserves the public surface (record, author, recipient, transcription, enhancedAudioUrl)', () => {
        const out = toReplyViewPublic(fullReplyView());
        expect(out.record).toBeDefined();
        expect(out.author).toBeDefined();
        expect(out.recipient).toBeDefined();
        expect(out.transcription).toBe('Hello world');
        expect(out.enhancedAudioUrl).toBe('https://example.com/enhanced.webm');
    });

    it('handles a sparse ReplyView (no enrichment fields populated)', () => {
        const sparse: ReplyView = {
            record: fullReplyView().record,
            author: fullReplyView().author,
            recipient: fullReplyView().recipient,
            isRead: false,
            isDeleted: false,
            readBy: [],
        };
        const out = toReplyViewPublic(sparse);
        // No fields to strip — nothing throws, output looks like input shape-wise.
        expect(out.record).toBe(sparse.record);
        expect(out.author).toBe(sparse.author);
        expect((out as Record<string, unknown>).aiSummary).toBeUndefined();
    });
});

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

describe('ReplyViewPublicSchema', () => {
    it('omits all the private-cluster fields from the schema shape', () => {
        // Round-trip: parse a public view through the schema and confirm it
        // doesn't carry the private keys (Zod strips unknown keys by default
        // on `omit`-derived schemas, so this is mostly a typing check —
        // here we assert the runtime behavior matches `toReplyViewPublic`).
        const v = fullReplyView();
        const projected = toReplyViewPublic(v);
        const parsed = ReplyViewPublicSchema.safeParse(projected);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            const keys = Object.keys(parsed.data);
            // Strip targets must NOT appear in the parsed output.
            expect(keys).not.toContain('listenerPhoneNumber');
            expect(keys).not.toContain('notes');
            expect(keys).not.toContain('aiSummary');
            expect(keys).not.toContain('socialVideoUrl');
            expect(keys).not.toContain('enhancedStoragePath');
        }
    });
});
