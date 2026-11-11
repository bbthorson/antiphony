/**
 * AT Protocol Namespaced Identifiers (NSIDs) for Antiphony record types.
 *
 * NSIDs are the canonical way to identify record types in AT Protocol.
 * This mapping connects AT Protocol NSIDs to storage collection / table names,
 * creating a single source of truth for the relationship.
 *
 * @see https://atproto.com/specs/nsid
 */

export const NSID = {
    // Antiphony canonical record types (dev.antiphony.*).
    // See lexicons/dev/antiphony/ + packages/shared/types/audio.ts.
    AudioPost: 'dev.antiphony.audio.post',
    AudioTranscript: 'dev.antiphony.audio.transcript',
    // Portable lexicon only — the core never stores actor profiles; the
    // caller BFF is the sole authority for profile data (see
    // specs/core-bff-boundary.md, "actor.profile lexicon"). Hence no
    // COLLECTIONS entry below.
    ActorProfile: 'dev.antiphony.actor.profile',
} as const;

export type NsidValue = typeof NSID[keyof typeof NSID];

/** The subset of record NSIDs the core actually stores. */
export type StoredNsidValue = typeof NSID.AudioPost | typeof NSID.AudioTranscript;

/**
 * Antiphony embed NSIDs. Embeds live inline on a post's `embed` field, not in
 * their own collection — kept out of `NSID`/`COLLECTIONS`.
 */
export const EMBED_NSID = {
    Audio: 'dev.antiphony.embed.audio',
    RecordWithAudio: 'dev.antiphony.embed.recordWithAudio',
} as const;

/**
 * XRPC method NSIDs — the `/xrpc/<nsid>` surface (see
 * specs/xrpc-and-atproto-lex-strategy.md).
 *
 * These are **siblings** of the record NSIDs in `NSID`, not children of them.
 * A method shares the authority segment (`dev.antiphony.audio`) with the record
 * but never nests under the record's own name: the record is
 * `dev.antiphony.audio.post` and the query that fetches it is
 * `dev.antiphony.audio.getPost`. Deriving one by appending to the other
 * produces `dev.antiphony.audio.post.getPost`, a different and undefined
 * namespace — hence a separate map rather than a helper over `NSID`.
 *
 * Queries are `GET`, procedures are `POST`; the grouping below follows that
 * split because it is mostly also the auth split (a hosted post's procedures
 * require an acting actor, queries may be viewer-less). The remote-post
 * procedures are the exception: a remote post has no author facet here, so
 * they are tenant-level.
 */
export const XRPC_NSID = {
    // Queries (GET).
    GetPost: 'dev.antiphony.audio.getPost',
    GetThread: 'dev.antiphony.audio.getThread',
    GetPlaybackUrl: 'dev.antiphony.audio.getPlaybackUrl',
    // Remote posts (specs/audio-service-mode.md): records held in other repos.
    GetRemotePost: 'dev.antiphony.audio.getRemotePost',
    GetRemoteThread: 'dev.antiphony.audio.getRemoteThread',
    ListRemotePosts: 'dev.antiphony.audio.listRemotePosts',
    GetRemotePosts: 'dev.antiphony.audio.getRemotePosts',
    // Counts for the calling tenancy (specs/tenancy-stats.md).
    GetStats: 'dev.antiphony.tenant.getStats',
    // Procedures (POST).
    CreatePost: 'dev.antiphony.audio.createPost',
    ReprocessPost: 'dev.antiphony.audio.reprocessPost',
    // Remote posts. Tenant-level, so unlike the two above they need no acting
    // actor: a service token is enough, as on their REST twins.
    RegisterPost: 'dev.antiphony.audio.registerPost',
    ReprocessRemotePost: 'dev.antiphony.audio.reprocessRemotePost',
    UnregisterPost: 'dev.antiphony.audio.unregisterPost',
    RecheckRemoteSpace: 'dev.antiphony.audio.recheckRemoteSpace',
} as const;

export type XrpcNsidValue = typeof XRPC_NSID[keyof typeof XRPC_NSID];

/**
 * Maps the STORED AT Protocol record-type NSIDs to database table names.
 * When migrating to a PDS, this mapping becomes the adapter layer.
 * `actor.profile` is deliberately absent — portable schema, no core storage.
 */
export const COLLECTIONS: Record<StoredNsidValue, string> = {
    // One post collection + the transcript enrichment namespace.
    [NSID.AudioPost]: 'posts',
    [NSID.AudioTranscript]: 'audio_transcripts',
};
