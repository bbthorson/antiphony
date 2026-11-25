import { describe, it, expect } from 'vitest';
import {
    RemoteSpaceUriSchema,
    RegisterRemotePostRequestSchema,
    RemoteAudioPostRecordSchema,
    RecheckRemoteSpaceRequestSchema,
    RecheckRemoteSpaceResultSchema,
    RemoteThreadViewSchema,
    RemoteThreadPageSchema,
    MAX_REMOTE_POSTS_BATCH,
} from './remote-posts';

const VALID_JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJkaWQ6cGxjOmFiYyJ9.c2lnbmF0dXJlMTIzNDU';
const VALID_SPACE_URI = 'at:space/did:plc:ewvi7nxzyoun6zhxrhs64oiz/dev.bardcast.campaign/camp1';
const VALID_POST_URI = 'at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/dev.antiphony.audio.post/3k2abc';

describe('RemoteSpaceUriSchema', () => {
    it('accepts valid at:space/{did}/{type}/{skey} URIs', () => {
        expect(RemoteSpaceUriSchema.safeParse(VALID_SPACE_URI).success).toBe(true);
        expect(
            RemoteSpaceUriSchema.safeParse('at:space/did:web:did.voxpop.audio/dev.voxpop.replies/prompt1').success,
        ).toBe(true);
    });

    it('rejects non-space AT URIs, trailing segments, non-DID authorities, and overlong strings', () => {
        expect(RemoteSpaceUriSchema.safeParse(VALID_POST_URI).success).toBe(false);
        expect(RemoteSpaceUriSchema.safeParse(`${VALID_SPACE_URI}/extra`).success).toBe(false);
        expect(RemoteSpaceUriSchema.safeParse('at:space/handle.bsky.social/t/k').success).toBe(false);
        // The alpha-era form, before 2026-11-24.
        expect(RemoteSpaceUriSchema.safeParse('at://did:plc:abc/space/type/skey').success).toBe(false);
        expect(
            RemoteSpaceUriSchema.safeParse(`at:space/did:plc:abc/type/${'a'.repeat(500)}`).success,
        ).toBe(false);
    });
});

describe('RegisterRemotePostRequestSchema', () => {
    it('accepts Phase A (public fetch), Phase B (pushed record), and Phase C (delegated space read) shapes', () => {
        expect(
            RegisterRemotePostRequestSchema.safeParse({
                uri: VALID_POST_URI,
                cid: 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
            }).success,
        ).toBe(true);

        expect(
            RegisterRemotePostRequestSchema.safeParse({
                uri: `${VALID_SPACE_URI}/did:plc:writer1/dev.antiphony.audio.post/rkey1`,
                cid: 'bafy123',
                bytesFrom: 'upload',
                record: { $type: 'dev.antiphony.audio.post', text: 'hello' },
            }).success,
        ).toBe(true);

        expect(
            RegisterRemotePostRequestSchema.safeParse({
                uri: `${VALID_SPACE_URI}/did:plc:writer1/dev.antiphony.audio.post/rkey1`,
                cid: 'bafy123',
                bytesFrom: 'fetch',
                delegationToken: VALID_JWT,
                clientAttestation: VALID_JWT,
            }).success,
        ).toBe(true);
    });

    it('rejects malformed delegationToken, empty cid, or invalid bytesFrom', () => {
        expect(
            RegisterRemotePostRequestSchema.safeParse({
                uri: VALID_POST_URI,
                cid: '',
            }).success,
        ).toBe(false);

        expect(
            RegisterRemotePostRequestSchema.safeParse({
                uri: VALID_POST_URI,
                cid: 'bafy123',
                bytesFrom: 'inline',
            }).success,
        ).toBe(false);

        expect(
            RegisterRemotePostRequestSchema.safeParse({
                uri: VALID_POST_URI,
                cid: 'bafy123',
                delegationToken: 'not-a-jwt',
            }).success,
        ).toBe(false);
    });
});

describe('RemoteAudioPostRecordSchema', () => {
    const baseRecord = {
        $type: 'dev.antiphony.audio.post' as const,
        text: 'A voice post',
        embed: {
            $type: 'dev.antiphony.embed.audio' as const,
            audio: {
                $type: 'blob' as const,
                ref: { $link: 'bafkreiabc123' },
                mimeType: 'audio/webm',
                size: 4096,
            },
        },
        createdAt: '2026-11-23T12:00:00.000Z',
    };

    it('accepts a valid audio post record and preserves unknown extension fields (.loose)', () => {
        const parsed = RemoteAudioPostRecordSchema.safeParse({
            ...baseRecord,
            futureField: 'kept',
            embed: { ...baseRecord.embed, extraEmbedField: 42 },
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect((parsed.data as Record<string, unknown>).futureField).toBe('kept');
        }
    });

    it('rejects invalid createdAt, wrong $type, or out-of-range waveform peaks', () => {
        expect(
            RemoteAudioPostRecordSchema.safeParse({ ...baseRecord, createdAt: 'not-a-date' }).success,
        ).toBe(false);
        expect(
            RemoteAudioPostRecordSchema.safeParse({ ...baseRecord, $type: 'app.bsky.feed.post' }).success,
        ).toBe(false);
        expect(
            RemoteAudioPostRecordSchema.safeParse({
                ...baseRecord,
                embed: { ...baseRecord.embed, waveform: [0, 50, 101] },
            }).success,
        ).toBe(false);
    });
});

describe('RecheckRemoteSpace schemas and thread page variants', () => {
    it('validates recheck request and result shapes', () => {
        expect(
            RecheckRemoteSpaceRequestSchema.safeParse({
                space: VALID_SPACE_URI,
                delegationToken: VALID_JWT,
            }).success,
        ).toBe(true);

        expect(
            RecheckRemoteSpaceResultSchema.safeParse({
                space: VALID_SPACE_URI,
                checked: 5,
                removed: 1,
                changed: 2,
                remaining: false,
            }).success,
        ).toBe(true);

        expect(
            RecheckRemoteSpaceResultSchema.safeParse({
                space: VALID_SPACE_URI,
                checked: -1,
                removed: 0,
                changed: 0,
                remaining: false,
            }).success,
        ).toBe(false);
    });

    it('distinguishes REST nullable thread fields from XRPC optional page fields', () => {
        expect(
            RemoteThreadViewSchema.safeParse({ root: null, replies: [], nextCursor: null }).success,
        ).toBe(true);
        expect(RemoteThreadPageSchema.safeParse({ replies: [] }).success).toBe(true);
        expect(MAX_REMOTE_POSTS_BATCH).toBe(25);
    });
});
