import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { BlobRefSchema } from 'shared/types/blob';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { StorageService } from '../../outbound/firebase/core-services-firebase.js';
import { cidForBytes } from '../../../lib/cid.js';
import { blobObjectPath } from '../../../lib/blob-path.js';
import { getOriginAppId } from '../../../lib/origin-app.js';
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

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const UploadResponseSchema = z.object({
    blob: BlobRefSchema.openapi({
        description:
            'Canonical AT Protocol blob ref for the stored audio — pass verbatim as the post embed\'s `audio`.',
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
        'the blob ref (`{ $type: "blob", ref: { $link: "<cid>" }, mimeType, size }`) to embed on a post.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.hourly)] as const,
    responses: {
        200: jsonResponse(UploadResponseSchema, 'Stored audio blob ref'),
        400: errorResponse('Missing/oversized file or unsupported audio type'),
        401: errorResponse('Not authenticated'),
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

    const buffer = Buffer.from(await file.arrayBuffer());
    const cid = await cidForBytes(buffer);
    const path = blobObjectPath(getOriginAppId(), cid);
    if (!path) {
        // Only reachable with a misconfigured origin app id — surface loudly.
        return c.json(errorEnvelope(c, 'Blob path could not be derived'), 400);
    }
    await StorageService.uploadFile(buffer, path, mimeType);

    return c.json({
        success: true as const,
        data: {
            blob: {
                $type: 'blob' as const,
                ref: { $link: cid },
                mimeType,
                size: buffer.byteLength,
            },
        },
    }, 200);
});

export { app as audioUploadRoute };
