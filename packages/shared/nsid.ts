/**
 * AT Protocol Namespaced Identifiers (NSIDs) for Vox Pop record types.
 *
 * NSIDs are the canonical way to identify record types in AT Protocol.
 * This mapping connects AT Protocol NSIDs to Firestore collection names,
 * creating a single source of truth for the relationship.
 *
 * @see https://atproto.com/specs/nsid
 */

export const NSID = {
    Prompt: 'com.voxpop.audio.prompt',
    Reply: 'com.voxpop.audio.reply',
    Profile: 'com.voxpop.actor.profile',
} as const;

export type NsidValue = typeof NSID[keyof typeof NSID];

/**
 * Maps AT Protocol NSIDs to Firestore collection names.
 * When migrating to a PDS, this mapping becomes the adapter layer.
 */
export const COLLECTIONS: Record<NsidValue, string> = {
    [NSID.Prompt]: 'prompts',
    [NSID.Reply]: 'replies',
    [NSID.Profile]: 'users',
};

/**
 * Reverse lookup: get the NSID for a Firestore collection name.
 */
export function nsidForCollection(collection: string): NsidValue | undefined {
    const entries = Object.entries(COLLECTIONS) as [NsidValue, string][];
    const match = entries.find(([, col]) => col === collection);
    return match?.[0];
}
