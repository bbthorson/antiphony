import {
    AudioPostRecordSchema,
    type AudioPostRecord,
    type AudioPostView,
    type AudioEmbed,
    type AudioEmbedView,
    type ReplyRef,
    type TranscriptEnrichmentRecord,
    type ViewerState,
} from 'shared/types/audio';
import type { SpacePlacement } from 'shared/types/spaces';
import { EMBED_NSID } from 'shared/nsid';
import {
    toProcessingView,
    resolveAudioVariant,
    type ResolvedProcessing,
} from 'shared/types/processing';
import { ForbiddenError, NotFoundError, ValidationError } from 'shared/errors';
import type {
    AudioPostDependencies,
    AudioPostQueryOptions,
    AudioPostThreadOptions,
} from '../ports/audio-posts-dependencies';
import { NSID } from 'shared/nsid';
import { AtUri, isValidDid, isValidNsid, isValidRecordKey } from '@atproto/syntax';

/**
 * AudioPostService — CRUD + batched hydration for the Antiphony canonical
 * `dev.antiphony.audio.post` model.
 *
 * Three model rules this service enforces (documented on the lexicons docs
 * page, apps/docs/src/content/docs/lexicons/overview.md):
 *  1. `kind` is derived from `reply` presence at write time (cheap index).
 *  2. The transcript is platform enrichment, **lifted into the embed view at
 *     read time** — never stored on the canonical record.
 *  3. The stored audio is a content CID (`BlobRef.ref.$link`); the view
 *     carries a playback URL resolved from it (the core's audio proxy; since
 *     0.5.0 stable and unsigned — signed playback for private spaces is
 *     specs/spaces.md Phase 2).
 */

export interface CreateAudioPostInput {
    /** Multi-tenant isolation key — the origin app creating the post. */
    originAppId: string;
    /** Authoring user id. */
    authorId: string;
    /** Optional AT Protocol identity of the author. */
    authorDid?: string;
    /** Optional org context. */
    orgId?: string | null;
    /** User-authored text. May be empty for pure-audio posts. */
    text: string;
    /** Optional headline (prompt feature only). */
    title?: string;
    /** The uploaded audio attachment. */
    embed?: AudioEmbed;
    /** Present ⇒ this post is a reply (StrongRef root + parent). */
    reply?: ReplyRef;
    /**
     * The space to create a PROMPT in (specs/spaces.md). The author segment is
     * derived: the author's DID, or the tenant's app DID when they have none.
     * A reply is always created in its parent's space; naming any other space
     * on a reply is refused. Absent ⇒ a flat, public post.
     */
    space?: { type: string; skey: string };
    /** BCP-47 language tags. */
    langs?: string[];
    /** Author self-label values. */
    selfLabels?: string[];
    /**
     * Resolved initial per-stage processing status (B5), when the app opted
     * into processing. The caller (route) resolves the request against the
     * deployment's capabilities into `pending`/`skipped`; the service just
     * stamps `updatedAt` and stores it. Absent ⇒ no processing.
     */
    processing?: ResolvedProcessing;
}

/**
 * Build a record's canonical `at://` uri, flat or in a space:
 *
 *     at://{authority}/{collection}/{rkey}                                            flat (public)
 *     at://{authority}/space/{type}/{skey}/{authorSegment}/{collection}/{rkey}        in a space
 *
 * The authority is the tenant's **app DID** — the repo owner under Antiphony's
 * app-as-repo-owner custody model (Model B), NOT the author. Author identity
 * (`authorId`/`authorDid`) stays on the record as attribution facets; inside a
 * space the protocol also needs an author segment, which is the placement's
 * `authorSegment` (specs/spaces.md, "The author segment"). Call sites resolve
 * the app DID from the record's `originAppId` via `deps.getAppDid` and pass it
 * in, so this stays a pure function with no hidden config lookup.
 *
 * The flat shape is built by hand so it stays byte-identical to every URI
 * already handed out. The space shape is built by `@atproto/syntax`
 * (`AtUri.makeSpace`), after every part is checked with its validators: a URI is
 * sealed into each reply's StrongRef, so a malformed one can never be minted.
 */
export function buildRecordUri(parts: {
    authority: string;
    collection: string;
    rkey: string;
    space?: SpacePlacement;
}): string {
    const { authority, collection, rkey, space } = parts;
    if (!space) return `at://${authority}/${collection}/${rkey}`;
    const { type, skey, authorSegment } = space;
    if (!isValidNsid(type)) throw new ValidationError(`Invalid space type (must be an NSID): ${type}`);
    if (!isValidRecordKey(skey)) throw new ValidationError(`Invalid space key (must be a record key): ${skey}`);
    if (!isValidDid(authorSegment)) throw new ValidationError(`Invalid space author segment (must be a DID): ${authorSegment}`);
    if (!isValidDid(authority)) throw new ValidationError(`Invalid space authority DID: ${authority}`);
    if (!isValidNsid(collection)) throw new ValidationError(`Invalid collection NSID: ${collection}`);
    if (!isValidRecordKey(rkey)) throw new ValidationError(`Invalid record key: ${rkey}`);
    return AtUri.makeSpace(authority, type, skey, authorSegment, collection, rkey).toString();
}

/** Reject a placement whose parts aren't valid atproto syntax (NSID, record key, DID). */
export function assertValidPlacement(space: SpacePlacement): void {
    if (!isValidNsid(space.type)) throw new ValidationError(`Invalid space type (must be an NSID): ${space.type}`);
    if (!isValidRecordKey(space.skey)) throw new ValidationError(`Invalid space key (must be a record key): ${space.skey}`);
    if (!isValidDid(space.authorSegment)) {
        throw new ValidationError(`Invalid space author segment (must be a DID): ${space.authorSegment}`);
    }
}

/**
 * Build a post's canonical uri. `space` is the post's own placement (absent for
 * a flat post). Exported so the threading query and the StrongRefs handed to
 * clients are generated by the same rule.
 */
export function buildPostUri(appDid: string, rkey: string, space?: SpacePlacement): string {
    return buildRecordUri({ authority: appDid, collection: NSID.AudioPost, rkey, ...(space ? { space } : {}) });
}

/** A post uri, parsed: its rkey and, for a post in a space, its placement. */
export interface ParsedPostUri {
    id: string;
    space?: SpacePlacement;
}

/**
 * Parse a post `at://` uri, flat or in a space — the inverse of `buildPostUri`
 * — but ONLY when the uri's authority is `expectedAppDid` (the caller's own
 * tenant app DID). A StrongRef whose authority is a different app DID — a
 * forged or cross-tenant reference — returns null, so it can't resolve inside
 * another tenant. This makes explicit, at parse time, the tenancy scope that
 * `resolveReplyParticipants` otherwise enforces only via the origin-app post
 * lookup. Returns null for a malformed/empty/non-matching uri, and for any
 * collection other than the audio-post one.
 */
export function parsePostUri(uri: string, expectedAppDid: string): ParsedPostUri | null {
    const AT = 'at://';
    if (!uri.startsWith(AT)) return null;
    // Segments: [authority, collection, rkey] for a flat uri. filter(Boolean)
    // drops empty segments so a trailing slash (or `//`) doesn't yield an empty
    // id.
    const segments = uri.slice(AT.length).split('/').filter(Boolean);
    // Authority MUST be the tenant's own app DID — reject cross-tenant/forged refs.
    if (segments[0] !== expectedAppDid) return null;

    if (segments[1] === 'space') return parseSpacePostUri(uri, expectedAppDid);

    // A well-formed flat post uri is exactly [authority, collection, rkey].
    if (segments.length !== 3) return null;
    // Collection MUST be the audio-post collection — reject cross-collection spoofing.
    if (segments[1] !== NSID.AudioPost) return null;
    const rkey = segments[2];
    return rkey && rkey.trim() ? { id: rkey } : null;
}

/** The space shape, read by `@atproto/syntax` and then held to the same rules as a flat uri. */
function parseSpacePostUri(uri: string, expectedAppDid: string): ParsedPostUri | null {
    let parsed: AtUri;
    try {
        parsed = new AtUri(uri);
    } catch {
        return null;
    }
    if (!parsed.isSpace || parsed.spaceDid !== expectedAppDid) return null;
    const { spaceType, skey, authorDid } = parsed;
    if (!spaceType || !skey || !authorDid) return null;
    if (parsed.collection !== NSID.AudioPost) return null;
    const rkey = parsed.rkey;
    if (!rkey || !isValidRecordKey(rkey)) return null;
    // Round-trip: a uri this service would not have built itself isn't one of its posts.
    const space: SpacePlacement = { type: spaceType, skey, authorSegment: authorDid };
    try {
        if (buildPostUri(expectedAppDid, rkey, space) !== uri) return null;
    } catch {
        return null;
    }
    return { id: rkey, space };
}

/** The post id (rkey) of a post uri, flat or in a space. See `parsePostUri`. */
export function parsePostId(uri: string, expectedAppDid: string): string | null {
    return parsePostUri(uri, expectedAppDid)?.id ?? null;
}

/** Same space: the same type, key and author segment. */
export function samePlacement(a: SpacePlacement | undefined, b: SpacePlacement | undefined): boolean {
    if (!a || !b) return a === b;
    return a.type === b.type && a.skey === b.skey && a.authorSegment === b.authorSegment;
}

/**
 * Project the post's public lexicon fields into the canonical
 * `dev.antiphony.audio.post` record shape — the object whose DAG-CBOR
 * encoding the record CID is computed over.
 *
 * Rules that keep the CID deterministic and atproto-faithful:
 *  - Public lexicon fields ONLY — storage/tenancy fields (`id`,
 *    `originAppId`, `authorId`, `kind`, `threadParticipants`) never enter
 *    the hash, so re-indexing can't change a record's identity.
 *  - Absent optionals are OMITTED (never `undefined`/`null` placeholders).
 *  - `createdAt` is the ISO-8601 string, as the lexicon stores it.
 *  - `selfLabels` is expanded to the lexicon's
 *    `com.atproto.label.defs#selfLabels` union shape.
 */
export function canonicalPostRecord(input: {
    text: string;
    title?: string;
    embed?: AudioEmbed;
    reply?: ReplyRef;
    langs?: string[];
    selfLabels?: string[];
    createdAt: Date;
}): Record<string, unknown> {
    return {
        $type: NSID.AudioPost,
        text: input.text,
        ...(input.title !== undefined ? { title: input.title } : {}),
        // Field-by-field (not a spread): a spread would carry explicitly-
        // `undefined` optionals through, and DAG-CBOR encoding throws on
        // `undefined` — omission is the only valid "absent".
        ...(input.embed !== undefined
            ? {
                  embed: {
                      $type: EMBED_NSID.Audio,
                      audio: input.embed.audio,
                      ...(input.embed.durationMs !== undefined ? { durationMs: input.embed.durationMs } : {}),
                      ...(input.embed.alt !== undefined ? { alt: input.embed.alt } : {}),
                      ...(input.embed.waveform !== undefined ? { waveform: input.embed.waveform } : {}),
                  },
              }
            : {}),
        ...(input.reply !== undefined ? { reply: input.reply } : {}),
        ...(input.langs !== undefined ? { langs: input.langs } : {}),
        ...(input.selfLabels !== undefined && input.selfLabels.length > 0
            ? {
                  labels: {
                      $type: 'com.atproto.label.defs#selfLabels',
                      values: input.selfLabels.map((val) => ({ val })),
                  },
              }
            : {}),
        createdAt: input.createdAt.toISOString(),
    };
}

export class AudioPostService {
    constructor(private readonly deps: AudioPostDependencies) {}

    /**
     * Create a canonical post. Derives `kind` from `reply` presence and drops
     * `title` on replies (the record invariant forbids it). The record is
     * schema-validated before it's persisted.
     */
    async createPost(input: CreateAudioPostInput): Promise<AudioPostRecord> {
        const kind: AudioPostRecord['kind'] = input.reply ? 'reply' : 'prompt';

        // Reply gating: resolve the parent to authorize the reply and derive
        // the branch metadata (participant pair + rootAuthorId recipient facet).
        // Prompts have no parent, so they skip this.
        const branch = input.reply
            ? await this.resolveReplyBranch(input.originAppId, input.authorId, input.reply)
            : undefined;
        const space = this.placementFor(input, branch?.space);
        if (space && !input.reply) await this.assertSpaceExists(input.originAppId, space);
        if (input.embed) await this.assertAudioPlacement(input.originAppId, input.embed.audio.ref.$link, space);

        const createdAt = this.deps.now();
        // Replies carry no title (record invariant); only prompts do.
        const title = kind === 'prompt' ? input.title : undefined;

        // Record CID — computed over the canonical lexicon projection (public
        // fields only) BEFORE persisting, so the stored record and every
        // StrongRef built from it carry a verifiable content address.
        const cid = await this.deps.cidForRecord(
            canonicalPostRecord({
                text: input.text,
                title,
                embed: input.embed,
                reply: input.reply,
                langs: input.langs,
                selfLabels: input.selfLabels,
                createdAt,
            }),
        );

        // Initial processing state (B5) — the caller already resolved the
        // request against deployment capabilities into per-stage
        // pending/skipped; we just stamp the clock. Storage-layer, not in the
        // CID above.
        const processing = input.processing
            ? { ...input.processing, updatedAt: createdAt }
            : undefined;

        const record = AudioPostRecordSchema.parse({
            id: this.deps.newPostId(),
            cid,
            originAppId: input.originAppId,
            authorId: input.authorId,
            authorDid: input.authorDid,
            orgId: input.orgId ?? undefined,
            kind,
            threadParticipants: branch?.participants,
            rootAuthorId: branch?.rootAuthorId,
            processing,
            space,
            text: input.text,
            title,
            embed: input.embed,
            reply: input.reply,
            langs: input.langs,
            selfLabels: input.selfLabels,
            createdAt,
        });

        await this.deps.savePost(record);
        return record;
    }

    /**
     * Re-stamp a post's async processing state and return the updated record —
     * the write half of the "trigger enrichment after the fact" PATCH. Only the
     * post's **author** may do it. `resolved` is the per-stage state the caller
     * already resolved against deployment capabilities (`pending`/`skipped`);
     * this merges it over any existing state (so re-requesting `denoise` never
     * clobbers a `ready` `transcribe`) and stamps `updatedAt`.
     *
     * `processing` is storage-layer (NOT in the lexicon or the record CID), so
     * this mutates NO public field and the record's content address is
     * unchanged — the post keeps its identity. Content edits are deliberately
     * out of scope: they would change the CID.
     */
    async setProcessing(
        originAppId: string,
        id: string,
        actorUid: string,
        resolved: ResolvedProcessing,
    ): Promise<AudioPostRecord> {
        const record = await this.deps.getPostById(originAppId, id);
        if (!record) {
            throw new NotFoundError('Post not found');
        }
        if (record.authorId !== actorUid) {
            throw new ForbiddenError('Only the author can trigger processing');
        }
        if (!record.embed) {
            throw new ValidationError('Post has no audio to process');
        }

        if (this.deps.patchProcessingState) {
            await this.deps.patchProcessingState(originAppId, id, resolved);
            const fresh = await this.deps.getPostById(originAppId, id);
            return (
                fresh ?? {
                    ...record,
                    processing: {
                        ...record.processing,
                        ...resolved,
                        updatedAt: this.deps.now(),
                    },
                }
            );
        }

        const updated: AudioPostRecord = {
            ...record,
            processing: {
                ...record.processing,
                ...resolved,
                updatedAt: this.deps.now(),
            },
        };
        await this.deps.savePost(updated);
        return updated;
    }

    /**
     * Where a new post lives (specs/spaces.md):
     *  - a reply lives in its parent's space, always: a public reply to a
     *    private post would publish part of a private conversation. Naming a
     *    different space on a reply is refused rather than ignored.
     *  - a prompt lives in the space it names, or is flat.
     * The author segment is the acting author's DID, or the tenant's app DID when
     * they have none (Model B preserved inside a space).
     */
    private placementFor(
        input: CreateAudioPostInput,
        parentSpace: SpacePlacement | undefined,
    ): SpacePlacement | undefined {
        if (input.reply) {
            const named = input.space;
            if (named && (named.type !== parentSpace?.type || named.skey !== parentSpace?.skey)) {
                throw new ValidationError("A reply is created in its parent's space; it can't name another");
            }
            if (!parentSpace) return undefined;
            return { type: parentSpace.type, skey: parentSpace.skey, authorSegment: this.authorSegment(input) };
        }
        if (!input.space) return undefined;
        const placement = { ...input.space, authorSegment: this.authorSegment(input) };
        assertValidPlacement(placement);
        return placement;
    }

    /** A prompt's space must exist for this tenant. (A reply's exists: its parent is in it.) */
    private async assertSpaceExists(originAppId: string, space: SpacePlacement): Promise<void> {
        const found = await this.deps.getSpace(originAppId, { type: space.type, skey: space.skey });
        if (!found) throw new NotFoundError('Space not found');
    }

    /**
     * The audio must live where the post does: uploaded into the post's space
     * for a post in a space, public for a flat post. Otherwise a private post's
     * audio would be publicly playable, or a public post's unplayable. Audio
     * that isn't stored at all is left to fail as it always has (at playback),
     * so flat posts behave exactly as before Phase 2.
     */
    private async assertAudioPlacement(
        originAppId: string,
        blobCid: string,
        space: SpacePlacement | undefined,
    ): Promise<void> {
        const stored = await this.deps.getBlobSpace(originAppId, blobCid);
        if (!stored) {
            if (space) throw new ValidationError('Audio not found: upload it into the space first');
            return;
        }
        const where = stored.space;
        if (space && (where?.type !== space.type || where?.skey !== space.skey)) {
            throw new ValidationError(
                where
                    ? 'This audio was uploaded into a different space'
                    : 'This audio was uploaded as public; upload it into the space to post it there',
            );
        }
        if (!space && where) {
            throw new ValidationError('This audio was uploaded into a space; a public post can\'t use it');
        }
    }

    private authorSegment(input: CreateAudioPostInput): string {
        return input.authorDid ?? this.deps.getAppDid(input.originAppId);
    }

    /**
     * Authorize a reply and resolve its branch metadata (§6 "Reply gating"):
     * the participant pair AND the `rootAuthorId` recipient facet. Throws when
     * the parent/root is missing/cross-tenant (404) or the author isn't allowed
     * to reply (403).
     *
     * - parent is the **prompt** (thread-root): any authenticated author may
     *   answer (the app's default audience policy); the branch opens with
     *   `{ creator (prompt author), this responder }`.
     * - parent is a **reply**: only the branch's existing participants may
     *   continue — the pair is inherited unchanged. Keying off the branch pair
     *   (not `parent.author`) is what lets the creator ↔ responder back-and-forth
     *   continue past the second turn.
     *
     * `rootAuthorId` is the author of the thread ROOT (the prompt) — the reply's
     * recipient. It's derived from the parent WITHOUT an extra read, inherited
     * down the branch exactly like `threadParticipants`:
     *  - parent is the **prompt** ⇒ the prompt IS the root, so `rootAuthorId =
     *    parent.authorId`.
     *  - parent is a **reply** ⇒ inherit `parent.rootAuthorId` (the record schema
     *    stamps it on every reply, so a reply parent always carries it).
     * This keeps the root recipient a pure function of the already-fetched
     * parent — no dependency on `reply.root.uri`'s authority, no thread walk.
     */
    private async resolveReplyBranch(
        originAppId: string,
        authorId: string,
        reply: ReplyRef,
    ): Promise<{ participants: string[]; rootAuthorId: string; space?: SpacePlacement }> {
        const parsed = parsePostUri(reply.parent.uri, this.deps.getAppDid(originAppId));
        const parent = parsed ? await this.deps.getPostById(originAppId, parsed.id) : null;
        // The uri must name the parent where it actually lives: a real post id
        // under a different (or missing) space is a forged reference, and is
        // treated exactly like a missing parent.
        if (!parent || !samePlacement(parsed?.space, parent.space)) {
            throw new NotFoundError('Parent post not found');
        }
        const space = parent.space;

        if (parent.kind === 'prompt') {
            // Top-level reply: the audience answers the call. Deduped so a
            // creator replying to their own prompt collapses to a single id.
            // The prompt is the thread root, so its author is the recipient.
            return {
                participants: Array.from(new Set([parent.authorId, authorId])),
                rootAuthorId: parent.authorId,
                ...(space ? { space } : {}),
            };
        }

        // Reply to a reply: participant-only. Inherit the established pair AND
        // the root-author facet from the parent branch.
        const participants = parent.threadParticipants ?? [parent.authorId];
        if (!participants.includes(authorId)) {
            throw new ForbiddenError('Only the thread participants can reply here');
        }
        // The record schema requires `rootAuthorId` on every reply, so a reply
        // parent read back through `getPostById` always carries it. Assert the
        // invariant at this type boundary rather than substitute a wrong id.
        if (parent.rootAuthorId === undefined) {
            throw new Error('Invariant: reply parent is missing its rootAuthorId facet');
        }
        return { participants, rootAuthorId: parent.rootAuthorId, ...(space ? { space } : {}) };
    }

    /**
     * Fetch a single hydrated post view, scoped to `originAppId`. Returns null
     * when the post is missing or owned by a different origin app.
     */
    async getPostView(
        originAppId: string,
        id: string,
        viewerUid: string | null,
    ): Promise<AudioPostView | null> {
        const record = await this.deps.getPostById(originAppId, id);
        if (!record) return null;
        const [view] = await this.hydrateAudioPosts([record], viewerUid);
        return view ?? null;
    }

    /** List the author's posts (origin-app-scoped), hydrated. */
    async getPostsForAuthor(
        originAppId: string,
        authorId: string,
        viewerUid: string | null,
        options?: AudioPostQueryOptions,
    ): Promise<AudioPostView[]> {
        const records = await this.deps.queryByAuthor(originAppId, authorId, options);
        return this.hydrateAudioPosts(records, viewerUid);
    }

    /**
     * List replies whose thread ROOT was authored by `rootAuthorId`
     * (origin-app-scoped), hydrated, reverse-chronological. The storage
     * primitive a caller BFF composes into a "replies to me" / inbox feed —
     * Antiphony itself stays product-agnostic.
     */
    async getRepliesByRootAuthor(
        originAppId: string,
        rootAuthorId: string,
        viewerUid: string | null,
        options?: AudioPostQueryOptions,
    ): Promise<AudioPostView[]> {
        const records = await this.deps.queryByRootAuthor(originAppId, rootAuthorId, options);
        return this.hydrateAudioPosts(records, viewerUid);
    }

    /** List replies to a post (origin-app-scoped), hydrated in thread order. */
    async getReplies(
        originAppId: string,
        parentUri: string,
        viewerUid: string | null,
        options?: AudioPostThreadOptions,
    ): Promise<AudioPostView[]> {
        const records = await this.deps.queryReplies(originAppId, parentUri, options);
        return this.hydrateAudioPosts(records, viewerUid);
    }

    /**
     * Batched hydration (records → views). Loads transcript enrichments in ONE
     * round (N+1 ban), then assembles per-record views: lifts the transcript,
     * resolves the audio playback URL, and computes viewer state. Author identity is NOT
     * hydrated — the view carries opaque `authorId`/`authorDid` refs and the
     * caller BFF joins on them (see specs/core-surface.md).
     */
    async hydrateAudioPosts(
        records: AudioPostRecord[],
        viewerUid: string | null,
    ): Promise<AudioPostView[]> {
        if (records.length === 0) return [];

        // Resolve authority per-record: a hydration batch can span tenants, and
        // each record's uri is keyed on ITS tenant's app DID.
        const uris = records.map((r) => buildPostUri(this.deps.getAppDid(r.originAppId), r.id, r.space));

        const transcriptMap = await this.deps.getTranscriptsBySubjectUris(uris);

        return Promise.all(
            records.map((record) => this.hydrateOne(record, transcriptMap, viewerUid)),
        );
    }

    private async hydrateOne(
        record: AudioPostRecord,
        transcriptMap: Map<string, TranscriptEnrichmentRecord>,
        viewerUid: string | null,
    ): Promise<AudioPostView> {
        const uri = buildPostUri(this.deps.getAppDid(record.originAppId), record.id, record.space);

        // --- Hydrated audio embed (playback URL + lifted transcript) ---
        // Guard the nested audio ref defensively: although a parsed record with
        // an `embed` always carries `audio.ref.$link` (schema-enforced), the
        // hydrator is a read boundary that may see records from other code paths.
        const embedRecord = record.embed;
        let embed: AudioEmbedView | undefined;
        if (embedRecord?.audio?.ref?.$link) {
            // Playback, duration and peaks resolve TOGETHER against the
            // processed variant once one exists; the record's own fields stay
            // the immutable originals. Resolving them separately here is what
            // used to leave a processed URL beside the original duration.
            const proc = record.processing;
            const resolved = resolveAudioVariant(
                {
                    blobCid: embedRecord.audio.ref.$link,
                    durationMs: embedRecord.durationMs,
                    waveform: embedRecord.waveform,
                },
                proc,
            );
            const playbackUrl = await this.deps.resolveAudioUrl(
                record.originAppId,
                resolved.blobCid,
                record.space ? { type: record.space.type, skey: record.space.skey } : undefined,
            );
            if (playbackUrl) {
                embed = {
                    $type: 'dev.antiphony.embed.audio#view',
                    url: playbackUrl,
                    durationMs: resolved.durationMs,
                    alt: embedRecord.alt,
                    waveform: resolved.waveform,
                    transcript: transcriptMap.get(uri)?.transcript,
                    // Surface per-stage processing status (no internal fields)
                    // when the app opted in; absent otherwise.
                    processing: proc ? toProcessingView(proc) : undefined,
                };
            }
        }

        return {
            uri,
            cid: record.cid,
            kind: record.kind,
            // Opaque attribution refs, straight off the record — no profile
            // lookup. The BFF hydrates display identity by joining on authorId.
            authorId: record.authorId,
            authorDid: record.authorDid,
            record: {
                text: record.text,
                title: record.title,
                reply: record.reply,
                langs: record.langs,
                selfLabels: record.selfLabels,
                createdAt: record.createdAt,
            },
            embed,
            viewer: this.computeViewerState(record, viewerUid),
        };
    }

    /**
     * Per-viewer state: authorship + reply gating (§6). A prompt is repliable by
     * any authenticated viewer (audience-policy default); a reply only by its
     * branch participants. Anonymous viewers can't reply to anything.
     */
    private computeViewerState(record: AudioPostRecord, viewerUid: string | null): ViewerState {
        const isAuthor = viewerUid !== null && viewerUid === record.authorId;

        if (viewerUid === null) {
            return { isAuthor, canReply: false, replyDisabledReason: 'unauthenticated' };
        }
        if (record.kind === 'prompt') {
            return { isAuthor, canReply: true };
        }
        const participants = record.threadParticipants ?? [record.authorId];
        return participants.includes(viewerUid)
            ? { isAuthor, canReply: true }
            : { isAuthor, canReply: false, replyDisabledReason: 'not_a_participant' };
    }
}
