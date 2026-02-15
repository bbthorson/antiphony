"use strict";
/**
 * AT Protocol Namespaced Identifiers (NSIDs) for Vox Pop record types.
 *
 * NSIDs are the canonical way to identify record types in AT Protocol.
 * This mapping connects AT Protocol NSIDs to Firestore collection names,
 * creating a single source of truth for the relationship.
 *
 * @see https://atproto.com/specs/nsid
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.COLLECTIONS = exports.NSID = void 0;
exports.nsidForCollection = nsidForCollection;
exports.NSID = {
    Prompt: 'com.voxpop.audio.prompt',
    Reply: 'com.voxpop.audio.reply',
    Profile: 'com.voxpop.actor.profile',
};
/**
 * Maps AT Protocol NSIDs to Firestore collection names.
 * When migrating to a PDS, this mapping becomes the adapter layer.
 */
exports.COLLECTIONS = {
    [exports.NSID.Prompt]: 'prompts',
    [exports.NSID.Reply]: 'replies',
    [exports.NSID.Profile]: 'users',
};
/**
 * Reverse lookup: get the NSID for a Firestore collection name.
 */
function nsidForCollection(collection) {
    const entries = Object.entries(exports.COLLECTIONS);
    const match = entries.find(([, col]) => col === collection);
    return match === null || match === void 0 ? void 0 : match[0];
}
