import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomUUID } from 'crypto';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { StorageService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * POST /api/v1/audio/upload
 *
 * Authenticated audio upload — used by the on-domain reply flow (where
 * the client is already in apps/web's session). The embed-redirect flow
 * uses the separate `/api/v1/audio/upload-pending` endpoint (anonymous,
 * prompt-scoped, TTL-swept).
 *
 * Accepts multipart/form-data with a `file` field. Returns
 * `{ audioUrl: string }`.
 *
 * Replaces the legacy `POST /api/v1/uploads/audio`. Folded under
 * `/api/v1/audio/*` so audio storage operations share one namespace
 * with the signed-URL proxy at `/api/v1/audio` — uploads are transport,
 * not /replies sub-resources.
 *
 * Parity with: apps/web/src/app/api/v1/audio/upload/route.ts
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

const EXT_MAP: Record<string, string> = {
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
};

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const UploadResponseSchema = z.object({
    audioUrl: z.string().openapi({ description: 'Canonical storage URL of the stored object' }),
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
        'types: m4a, mp4, mpeg, webm, ogg, wav). Stores under `audio/<uid>/...` and returns its URL. ' +
        'Anonymous embed uploads use `POST /api/v1/audio/upload-pending` instead.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.hourly)] as const,
    responses: {
        200: jsonResponse(UploadResponseSchema, 'Stored audio URL'),
        400: errorResponse('Missing/oversized file or unsupported audio type'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(uploadRoute, async (c) => {
    const uid = c.get('viewerUid')!;

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

    const ext = EXT_MAP[mimeType] || 'm4a';
    const path = `audio/${uid}/${Date.now()}-${randomUUID()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    const audioUrl = await StorageService.uploadFile(buffer, path, mimeType);

    return c.json({ success: true as const, data: { audioUrl } }, 200);
});

export { app as audioUploadRoute };
