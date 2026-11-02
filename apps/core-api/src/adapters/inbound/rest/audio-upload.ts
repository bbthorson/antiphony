import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { BlobRefSchema } from 'shared/types/blob';
import { ScopedSpaceKeySchema, type ScopedSpaceKey } from 'shared/types/spaces';
import type { RemoteSpace } from 'shared/types/remote-posts';
import { NotFoundError, ServiceError } from 'shared/errors';
import { parseRemoteSpaceUri } from '@antiphony/core/services/remote-posts';
import { rateLimit, RATE_LIMITS, actingActorKey } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { servicesFor } from '../../../composition.js';
import { cidForBytes } from '../../../lib/cid.js';
import { blobObjectPath } from '../../../lib/blob-path.js';
import { blobSpaceMetadata, blobSpaceOf } from '../../../lib/blob-space.js';
import { getOriginAppId } from '../../../lib/origin-app.js';
import { getAppDid } from '../../../lib/app-did.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * POST /api/v1/audio/upload
 *
 * Authenticated audio upload. Accepts multipart/form-data with a `file`
 * field; hashes the bytes to a content CID (CIDv1, raw, sha2-256), stores
 * them at the CID-derived, tenancy-scoped path (`blobs/{originAppId}/{cid}`
 * — see lib/blob-path.ts), and returns the canonical AT Protocol blob ref:
 *
 *     { "blob": { "$type": "blob", "ref": { "$link": "<cid>" }, "mimeType", "size" } }
 *
 * The client passes that blob ref verbatim as the post embed's `audio`
 * field. Identical bytes re-uploaded land on the same object (content
 * addressing gives dedup for free).
 *
 * ## Uploading into a space
 *
 * Optional `spaceType` + `skey` fields name one of the tenant's spaces
 * (specs/spaces.md). The blob is then **private**: its object carries the
 * space in R2 custom metadata (lib/blob-space.ts), and the proxy plays it only
 * through a signed, expiring URL. The path stays `blobs/{originAppId}/{cid}`,
 * so renditions and processing need nothing new. An optional `spaceAuthority`
 * names a space under a DID the tenant registered rather than its app DID
 * (specs/did-plc-and-multi-did-tenancy.md §3); it is recorded beside the space.
 *
 * ## Uploading for a space held elsewhere
 *
 * Optional `remoteSpace` names a space Antiphony doesn't host, as a URI
 * (`at://{authority}/space/{type}/{skey}`), typically a group's space on its
 * group host (specs/audio-service-mode.md §4.2, Phase B). The tenant read the
 * bytes from that space and pushes them here, then registers the space record
 * with `PUT /api/v1/remote-posts`. The blob is private, marked with that space
 * and its authority exactly as above, but no Antiphony space is looked up: the
 * authority is a group's DID, which is never registered here, and R2 metadata
 * has no foreign keys. A space under the tenant's own app DID, or a DID it
 * registered, is hosted here and uses `spaceType` + `skey` instead.
 *
 * **The first upload wins.** The same bytes are the same object, so a second
 * upload never rewrites it, and never changes its visibility either way. The
 * response's `space` says where the blob actually lives; a post placed in a
 * space refuses audio that doesn't live in that same space.
 */

const ALLOWED_TYPES = new Set([
    'audio/m4a',
    'audio/x-m4a',
    'audio/mp4',
    'audio/mpeg',
    'audio/webm',
    'audio/ogg',
    'audio/wav',
]);

const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

/**
 * Transport-level cap, enforced before the body is read.
 *
 * Sits slightly above `MAX_SIZE` because multipart framing (the boundary
 * delimiters and per-part headers) rides on top of the file bytes — capping the
 * *body* at exactly `MAX_SIZE` would reject a legitimate 25 MB file. The exact
 * file-size check stays in the handler, where `file.size` is the real number.
 */
const MAX_BODY_SIZE = MAX_SIZE + 64 * 1024;

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const UploadResponseSchema = z.object({
    blob: BlobRefSchema.openapi({
        description:
            'Canonical AT Protocol blob ref for the stored audio — pass verbatim as the post embed\'s `audio`.',
    }),
    space: ScopedSpaceKeySchema.optional().openapi({
        description:
            'The space the blob is stored in, when it is private. Absent ⇒ public. `authority` is present when the ' +
            "space is under a DID other than the app's own. The first upload of the same bytes decides this, so it " +
            'can differ from the space this request named.',
    }),
});

// The body is multipart/form-data parsed manually in the handler (Web
// `File`), not via a Zod body schema — the field contract is documented in
// the route description rather than a generated body schema (binary form
// fields don't round-trip cleanly through zod-openapi, and the handler keeps
// its specific size/MIME error messages).
const uploadRoute = createRoute({
    method: 'post',
    path: '/',
    tags: ['Audio'],
    summary: 'Upload audio (authenticated)',
    description:
        'Authenticated multipart/form-data upload with a single `file` field (max 25MB; ' +
        'types: m4a, mp4, mpeg, webm, ogg, wav). Stores the bytes content-addressed and returns ' +
        'the blob ref (`{ $type: "blob", ref: { $link: "<cid>" }, mimeType, size }`) to embed on a post. ' +
        'Optional `spaceType` + `skey` fields store it privately in one of the tenant\'s spaces, with an optional ' +
        '`spaceAuthority` for a space under a DID the tenant registered; the first upload of the same bytes ' +
        'decides where they live, and the response\'s `space` says which. Optional `remoteSpace` ' +
        '(`at://{authority}/space/{type}/{skey}`, instead of the other space fields) stores it privately for a space ' +
        'held outside Antiphony, such as a group\'s space on its group host, before registering the space record with ' +
        '`PUT /api/v1/remote-posts`; no Antiphony space is needed.',
    middleware: [
        requireAuth(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.hourly, { keyBy: actingActorKey }),
        // Bound the body BEFORE the handler's `c.req.formData()` buffers it
        // whole. Without this the 25 MB check below only ran after the bytes
        // were already resident, so an authenticated caller could spend the
        // instance's memory `hourly`-limit times an hour on a minInstances: 0
        // backend. Rejects on Content-Length when present, otherwise aborts the
        // stream once the cap is passed.
        //
        // The handler's own `file.size` guard stays: this caps the whole
        // multipart envelope, not the file part, and a request that omits or
        // understates Content-Length is caught there.
        bodyLimit({
            maxSize: MAX_BODY_SIZE,
            // Same 400 + message the handler's size guard returns, so the
            // documented contract has one oversized-upload response, not two.
            onError: (c) => c.json(errorEnvelope(c, 'File too large (max 25MB)'), 400),
        }),
    ] as const,
    responses: {
        200: jsonResponse(UploadResponseSchema, 'Stored audio blob ref'),
        400: errorResponse(
            'Missing/oversized file, unsupported audio type, an invalid space, or a `remoteSpace` that is hosted here',
        ),
        401: errorResponse('Not authenticated'),
        404: errorResponse('Space not found'),
    },
});

app.openapi(uploadRoute, async (c) => {
    // requireAuth guarantees a viewer; the blob itself is tenancy-scoped, not
    // user-scoped (the post record carries authorship).
    c.get('viewerUid')!;

    let formData: FormData;
    try {
        formData = await c.req.formData();
    } catch {
        return c.json(errorEnvelope(c, 'Expected multipart/form-data'), 400);
    }

    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
        return c.json(errorEnvelope(c, 'Missing "file" field'), 400);
    }

    if (file.size > MAX_SIZE) {
        return c.json(errorEnvelope(c, 'File too large (max 25MB)'), 400);
    }

    const mimeType = file.type || 'audio/mp4';
    if (!ALLOWED_TYPES.has(mimeType)) {
        return c.json(errorEnvelope(c, `Unsupported audio type: ${mimeType}`), 400);
    }

    const originAppId = getOriginAppId(c);
    const services = servicesFor(c.env);

    // Both or neither: half a space names nothing. An authority alone names nothing either.
    const spaceType = formData.get('spaceType');
    const skey = formData.get('skey');
    const spaceAuthority = formData.get('spaceAuthority');
    const remoteSpace = formData.get('remoteSpace');
    let requested: ScopedSpaceKey | undefined;
    if (remoteSpace !== null) {
        if (spaceType !== null || skey !== null || spaceAuthority !== null) {
            return c.json(errorEnvelope(c, 'Send "remoteSpace" or "spaceType" + "skey", not both'), 400);
        }
        let space: RemoteSpace;
        try {
            space = parseRemoteSpaceUri(typeof remoteSpace === 'string' ? remoteSpace : '');
        } catch (err) {
            if (err instanceof ServiceError) return c.json(errorEnvelope(c, err.message), 400);
            throw err;
        }
        if (await isHostedAuthority(originAppId, space.authority, services)) {
            return c.json(
                errorEnvelope(
                    c,
                    'That space is under a DID this tenant hosts here; upload with "spaceType", "skey" and "spaceAuthority"',
                ),
                400,
            );
        }
        // Recorded with its authority always: it is never the app DID.
        requested = space;
    } else if (spaceType !== null || skey !== null || spaceAuthority !== null) {
        const parsed = ScopedSpaceKeySchema.safeParse({
            type: spaceType,
            skey,
            ...(spaceAuthority !== null ? { authority: spaceAuthority } : {}),
        });
        if (!parsed.success) {
            return c.json(
                errorEnvelope(c, 'Invalid space: send both "spaceType" and "skey", and "spaceAuthority" only as a DID', {
                    issues: parsed.error.issues,
                }),
                400,
            );
        }
        // Throws 404 for a space this tenant doesn't have under that authority.
        await services.spaceService.getSpace(originAppId, parsed.data);
        // Recorded as the services store it: no authority for the app DID.
        const { authority, ...key } = parsed.data;
        requested = authority !== undefined && authority !== getAppDid(originAppId) ? { ...key, authority } : key;
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const cid = await cidForBytes(buffer);
    const path = blobObjectPath(originAppId, cid);
    if (!path) {
        // Only reachable with a misconfigured origin app id — surface loudly.
        return c.json(errorEnvelope(c, 'Blob path could not be derived'), 400);
    }

    // First upload wins: an object already there keeps its bytes and its
    // visibility. Two concurrent first uploads race to the same bytes, and the
    // later marker wins; both callers then see `space` on a re-read, and a
    // post's placement check refuses the mismatch either way.
    const existing = await services.storage.stat(path);
    let space: ScopedSpaceKey | null;
    if (existing) {
        space = blobSpaceOf(existing.metadata);
    } else {
        await services.storage.uploadFile(
            buffer,
            path,
            mimeType,
            requested ? { metadata: blobSpaceMetadata(requested) } : undefined,
        );
        space = requested ?? null;
    }

    return c.json({
        success: true as const,
        data: {
            blob: {
                $type: 'blob' as const,
                ref: { $link: cid },
                mimeType,
                size: buffer.byteLength,
            },
            ...(space
                ? { space: { type: space.type, skey: space.skey, ...(space.authority !== undefined ? { authority: space.authority } : {}) } }
                : {}),
        },
    }, 200);
});

/** Whether `did` is the tenant's app DID or a DID it registered: its spaces are hosted here. */
async function isHostedAuthority(
    originAppId: string,
    did: string,
    services: ReturnType<typeof servicesFor>,
): Promise<boolean> {
    if (did === getAppDid(originAppId)) return true;
    try {
        await services.didRegistryService.get(originAppId, did);
        return true;
    } catch (err) {
        if (err instanceof NotFoundError) return false;
        throw err;
    }
}

export { app as audioUploadRoute };
