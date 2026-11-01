import { describe, it, expect } from 'vitest';
import { BLOB_SPACE_AUTHORITY_METADATA_KEY, BLOB_SPACE_METADATA_KEY, blobSpaceMetadata, blobSpaceOf } from './blob-space.js';

/**
 * The marker that decides whether the audio proxy serves a blob unsigned
 * (specs/spaces.md, Phase 2). The property that matters most is the failure
 * direction: a marker that can't be read must never read as public.
 */
describe('blob space marker', () => {
    const SPACE = { type: 'game.bardcast.space.campaign', skey: '3kcampaign2abc' };

    it('round-trips a space through the metadata', () => {
        expect(blobSpaceOf(blobSpaceMetadata(SPACE))).toEqual(SPACE);
    });

    it('reads a DID as the space key, colons intact', () => {
        const player = { type: 'game.bardcast.space.player', skey: 'did:plc:abc123' };
        expect(blobSpaceOf(blobSpaceMetadata(player))).toEqual(player);
    });

    it("records a space's authority beside it, and reads a blob without one as the app DID's", () => {
        const table = { type: 'game.bardcast.space.campaign', skey: 'thornwood', authority: 'did:plc:abcdefghijklmnopqrstuvwx' };
        const metadata = blobSpaceMetadata(table);
        expect(metadata[BLOB_SPACE_AUTHORITY_METADATA_KEY]).toBe(table.authority);
        expect(blobSpaceOf(metadata)).toEqual(table);
        // Every blob stored before authorities existed carries only the first key.
        expect(blobSpaceOf({ [BLOB_SPACE_METADATA_KEY]: 'game.bardcast.space.campaign/thornwood' })).toEqual({
            type: 'game.bardcast.space.campaign',
            skey: 'thornwood',
        });
        expect(blobSpaceMetadata({ type: 'a.b.c', skey: 'k' })).not.toHaveProperty(BLOB_SPACE_AUTHORITY_METADATA_KEY);
    });

    it('reads no marker as public', () => {
        expect(blobSpaceOf(undefined)).toBeNull();
        expect(blobSpaceOf({})).toBeNull();
        expect(blobSpaceOf({ [BLOB_SPACE_METADATA_KEY]: '' })).toBeNull();
    });

    it('fails closed on a marker it cannot read', () => {
        // Each of these is "in some space we can't name", so private: reading
        // them as public would serve the bytes without a signature.
        for (const raw of ['no-slash', '/leading', 'trailing/']) {
            const space = blobSpaceOf({ [BLOB_SPACE_METADATA_KEY]: raw });
            expect(space, raw).not.toBeNull();
            expect(space, raw).toEqual({ type: 'invalid.antiphony.space', skey: 'unreadable' });
        }
    });
});
