/**
 * AT Protocol Namespaced Identifiers (NSIDs) for Antiphony record types.
 *
 * NSIDs are the canonical way to identify record types in AT Protocol.
 * This mapping connects AT Protocol NSIDs to Firestore collection names,
 * creating a single source of truth for the relationship.
 *
 * @see https://atproto.com/specs/nsid
 */

export const NSID = {
    // Antiphony canonical record types (dev.antiphony.*).
    // See lexicons/dev/antiphony/ + packages/shared/types/audio.ts.
    AudioPost: 'dev.antiphony.audio.post',
    AudioTranscript: 'dev.antiphony.audio.transcript',
    ActorProfile: 'dev.antiphony.actor.profile',
} as const;

export type NsidValue = typeof NSID[keyof typeof NSID];

/**
 * Antiphony embed NSIDs. Embeds live inline on a post's `embed` field, not in
 * their own collection — kept out of `NSID`/`COLLECTIONS`.
 */
export const EMBED_NSID = {
    Audio: 'dev.antiphony.embed.audio',
    RecordWithAudio: 'dev.antiphony.embed.recordWithAudio',
} as const;

/**
 * Maps AT Protocol record-type NSIDs to Firestore collection names.
 * When migrating to a PDS, this mapping becomes the adapter layer.
 */
export const COLLECTIONS: Record<NsidValue, string> = {
    // One post collection + the transcript enrichment namespace + actors.
    [NSID.AudioPost]: 'posts',
    [NSID.AudioTranscript]: 'audio_transcripts',
    [NSID.ActorProfile]: 'users',
};
