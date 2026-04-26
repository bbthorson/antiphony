import { describe, it, expect } from 'vitest';
import { NSID } from 'shared/nsid';
import type { PromptRecord, UserRecord } from 'shared/types/records';
import { promptRecordToLexicon, profileRecordToLexicon } from './atproto-lexicon';

const baseCreatedAt = new Date('2026-04-25T12:00:00.000Z');

function makePrompt(overrides: Partial<PromptRecord> = {}): PromptRecord {
    return {
        id: 'prompt-1',
        authorId: 'user-1',
        title: 'What is your morning routine?',
        audioUrl: '',
        createdAt: baseCreatedAt,
        status: 'live',
        ...overrides,
    } as PromptRecord;
}

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
    return {
        id: 'user-1',
        domain: 'voxpop.com',
        createdAt: baseCreatedAt,
        tier: 'free',
        status: 'active',
        ...overrides,
    } as UserRecord;
}

describe('promptRecordToLexicon', () => {
    it('maps a full prompt with audio, description, and live status', () => {
        const result = promptRecordToLexicon(makePrompt({
            description: 'Tell me about it.',
            audio: { $type: 'blob', ref: 'bafyreigh1234', mimeType: 'audio/webm', size: 12345 },
        }));

        expect(result).toEqual({
            $type: NSID.Prompt,
            title: 'What is your morning routine?',
            description: 'Tell me about it.',
            audio: {
                $type: 'blob',
                ref: { $link: 'bafyreigh1234' },
                mimeType: 'audio/webm',
                size: 12345,
            },
            createdAt: '2026-04-25T12:00:00.000Z',
            status: 'live',
        });
    });

    it('omits audio when the record has no BlobRef (AT Proto requires absent, not null)', () => {
        const result = promptRecordToLexicon(makePrompt());
        expect(result.audio).toBeUndefined();
        expect(result).not.toHaveProperty('audio');
    });

    it('omits the description key entirely when not present', () => {
        const result = promptRecordToLexicon(makePrompt());
        expect(result).not.toHaveProperty('description');
    });

    it('passes through archived status', () => {
        const result = promptRecordToLexicon(makePrompt({ status: 'archived' }));
        expect(result.status).toBe('archived');
    });

    it('defensively maps deleted status to archived (callers should filter)', () => {
        const result = promptRecordToLexicon(makePrompt({ status: 'deleted' }));
        expect(result.status).toBe('archived');
    });

    it('serializes a string createdAt to ISO 8601', () => {
        const result = promptRecordToLexicon(makePrompt({
            createdAt: '2026-04-25T12:00:00.000Z' as unknown as Date,
        }));
        expect(result.createdAt).toBe('2026-04-25T12:00:00.000Z');
    });

    it('preserves blob mimeType, size, and ref through round-trip', () => {
        const result = promptRecordToLexicon(makePrompt({
            audio: { $type: 'blob', ref: 'bafyabc', mimeType: 'audio/mp4', size: 9876 },
        }));
        expect(result.audio).toEqual({
            $type: 'blob',
            ref: { $link: 'bafyabc' },
            mimeType: 'audio/mp4',
            size: 9876,
        });
    });

    it('uses the canonical NSID for $type', () => {
        const result = promptRecordToLexicon(makePrompt());
        expect(result.$type).toBe('com.voxpop.audio.prompt');
    });
});

describe('profileRecordToLexicon', () => {
    it('maps handle and usageIntent for a full user', () => {
        const result = profileRecordToLexicon(makeUser({
            handle: 'brad',
            usageIntent: 'Podcaster',
        }));

        expect(result).toEqual({
            $type: NSID.Profile,
            handle: 'brad',
            usageIntent: 'Podcaster',
        });
    });

    it('omits handle when the user has none (Lite User)', () => {
        const result = profileRecordToLexicon(makeUser({ usageIntent: 'Listener' }));
        expect(result).not.toHaveProperty('handle');
        expect(result.usageIntent).toBe('Listener');
    });

    it('omits usageIntent when not set', () => {
        const result = profileRecordToLexicon(makeUser({ handle: 'brad' }));
        expect(result).not.toHaveProperty('usageIntent');
    });

    it('does not surface rssFeed today (deferred — see TODO)', () => {
        const result = profileRecordToLexicon(makeUser({ handle: 'brad' }));
        expect(result).not.toHaveProperty('rssFeed');
    });

    it('uses the canonical NSID for $type', () => {
        const result = profileRecordToLexicon(makeUser());
        expect(result.$type).toBe('com.voxpop.actor.profile');
    });
});
