/**
 * AT Protocol Namespaced Identifiers (NSIDs) for Vox Pop record types.
 *
 * NSIDs are the canonical way to identify record types in AT Protocol.
 * This mapping connects AT Protocol NSIDs to Firestore collection names,
 * creating a single source of truth for the relationship.
 *
 * @see https://atproto.com/specs/nsid
 */
export declare const NSID: {
    readonly Prompt: "com.voxpop.audio.prompt";
    readonly Reply: "com.voxpop.audio.reply";
    readonly Profile: "com.voxpop.actor.profile";
};
export type NsidValue = typeof NSID[keyof typeof NSID];
/**
 * Maps AT Protocol NSIDs to Firestore collection names.
 * When migrating to a PDS, this mapping becomes the adapter layer.
 */
export declare const COLLECTIONS: Record<NsidValue, string>;
/**
 * Reverse lookup: get the NSID for a Firestore collection name.
 */
export declare function nsidForCollection(collection: string): NsidValue | undefined;
