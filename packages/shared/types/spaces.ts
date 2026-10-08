import { z } from 'zod';
import { TimestampSchema } from './records';
import { httpsUrl } from './url';

/**
 * atproto **spaces** (specs/spaces.md): permissioned repos with access control at
 * the space boundary. A space is the triple (authority DID, space type, space
 * key). In Antiphony the authority is always the calling tenant's own pinned DID,
 * so a tenant names a space by `{ type, skey }` alone.
 *
 * The checks here are deliberately light so this package stays dependency-free;
 * `@antiphony/core` validates every part with `@atproto/syntax` before it is
 * stored or sealed into a URI.
 */

// #region Space key and placement

/** An NSID, e.g. `game.bardcast.space.campaign`. */
const NsidSchema = z
    .string()
    .min(3)
    .max(317)
    .regex(/^[a-zA-Z][a-zA-Z0-9.-]*\.[a-zA-Z][a-zA-Z0-9]*$/, 'Must be an NSID');

/** atproto record-key syntax. A DID is a valid record key (colons are allowed). */
const RecordKeySchema = z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9._:~-]+$/, 'Must be a record key')
    .refine((k) => k !== '.' && k !== '..', 'Must be a record key');

/** A space, as a tenant names it: its type and key. */
export const SpaceKeySchema = z.object({
    /** The space type, an NSID, e.g. `game.bardcast.space.campaign`. */
    type: NsidSchema,
    /** The space key, in atproto record-key syntax. A DID is a valid skey. */
    skey: RecordKeySchema,
});
export type SpaceKey = z.infer<typeof SpaceKeySchema>;

/**
 * Where a post lives, when it lives in a space. Absent ⇒ the post is flat and
 * public: `at://{appDid}/{collection}/{rkey}`. Present ⇒
 * `at://{appDid}/space/{type}/{skey}/{authorSegment}/{collection}/{rkey}`, and
 * its visibility is the space's read policy, not a field on the post.
 *
 * Storage-layer, like `originAppId`: NOT in the lexicon and NOT in the record
 * CID. Placement is location, which atproto carries in the URI. Fixed at
 * creation, because a reply's StrongRef seals its parent's URI.
 */
export const SpacePlacementSchema = SpaceKeySchema.extend({
    /**
     * The DID in the URI's author segment: the acting actor's DID, or the
     * tenant's app DID when the actor has none. Sealed once the post is replied
     * to; `authorId` / `authorDid` stay facets beside it.
     */
    authorSegment: z.string().max(2048).regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/, 'Must be a DID'),
});
export type SpacePlacement = z.infer<typeof SpacePlacementSchema>;

// #endregion

// #region Space record and view

/**
 * Who may read, and who may write, a space. The protocol's three values (the
 * 2026-09-18 split of `policy` into `readPolicy` and `writePolicy`):
 *  - `public`: anyone.
 *  - `member-list`: the space's member list. The protocol default.
 *  - `managing-app`: the managing app decides, through `checkUserAccess`. When
 *    the tenant is that app, as it is for every Antiphony space today, its own
 *    service-token reads are already that decision.
 */
export const SpacePolicySchema = z.enum(['public', 'member-list', 'managing-app']);
export type SpacePolicy = z.infer<typeof SpacePolicySchema>;

/** A space as stored: tenant-scoped, keyed by `(originAppId, type, skey)`. */
export const SpaceRecordSchema = SpaceKeySchema.extend({
    /** The tenant whose DID is the space's authority. */
    originAppId: z.string(),
    readPolicy: SpacePolicySchema,
    writePolicy: SpacePolicySchema,
    /**
     * Where `checkUserAccess` is called for `managing-app` policies, for apps
     * OTHER than the tenant (Phase 3). Absent while the tenant is the only
     * reader.
     */
    managingAppEndpoint: httpsUrl().optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
});
export type SpaceRecord = z.infer<typeof SpaceRecordSchema>;

/** A space as the API returns it. */
export const SpaceViewSchema = SpaceKeySchema.extend({
    /** The space's own `at://` reference: `at://{appDid}/space/{type}/{skey}`. */
    uri: z.string().regex(/^at:\/\/.+\/space\/.+\/.+$/, 'Must be a space at:// URI'),
    readPolicy: SpacePolicySchema,
    writePolicy: SpacePolicySchema,
    managingAppEndpoint: httpsUrl().optional(),
    /** ISO 8601. */
    createdAt: z.string(),
    /** ISO 8601. */
    updatedAt: z.string(),
});
export type SpaceView = z.infer<typeof SpaceViewSchema>;

// #endregion
