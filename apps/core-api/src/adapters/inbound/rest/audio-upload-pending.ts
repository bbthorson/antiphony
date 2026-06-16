import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { promptService } from '../../outbound/firebase/core-services-firebase.js';
import { createPendingUpload, hashIp, extractClientIp } from '../../../lib/pending-uploads.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';
import { logger } from '../../../lib/logger.js';

/**
 * POST /api/v1/audio/upload-pending
 *
 * Anonymous audio upload endpoint for the embed-redirect flow: an iframe
 * records audio and POSTs here with `promptId` + `file` (multipart). We
 * rate-limit by IP, validate size / MIME / prompt existence, persist to
 * `pending/{id}.{ext}` + `pending_uploads/{id}`, and return the standard
 * envelope `{ success: true, data: { pendingId } }`.
 *
 * The iframe then redirects its top frame to the prompt page with
 * `?pending={pendingId}`; the authenticated `POST /replies` call binds the
 * pending to the now-known author.
 *
 * Abuse surface:
 *   - Unauthenticated → `RATE_LIMITS.sensitive` (5 per hour per IP).
 *   - Content-type allowlist mirrors the authenticated `/audio/upload`.
 *   - `promptId` must resolve to a live prompt (no dangling pendings).
 *   - Pending rows are prompt-scoped at write time; reply-bind refuses
 *     mismatch.
 *
 * Replaces the legacy `POST /api/v1/uploads/pending`. Folded under
 * `/api/v1/audio/*` so all audio storage operations live under one
 * namespace.
 *
 * Parity with: apps/web/src/app/api/v1/audio/upload-pending/route.ts
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

const MAX_SIZE = 25 * 1024 * 1024;
const MIN_SIZE = 512;

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const PendingResponseSchema = z.object({
    pendingId: z.string().openapi({ description: 'Opaque id to pass as `?pending=` when binding the reply' }),
});

// Multipart body (`file` + `promptId`) is parsed manually in the handler, not
// via a Zod body schema — see the note on the sibling `/audio/upload` route.
const uploadPendingRoute = createRoute({
    method: 'post',
    path: '/',
    tags: ['Audio'],
    summary: 'Upload audio (anonymous, embed)',
    description:
        'Anonymous multipart/form-data upload for the embed-redirect flow. Fields: `file` ' +
        '(512B–25MB; types: m4a, mp4, mpeg, webm, ogg, wav) and `promptId` (must be a live prompt). ' +
        'Persists a prompt-scoped pending upload and returns its `pendingId`; the authenticated ' +
        '`POST /api/v1/replies` later binds it to the author. Rate-limited per IP.',
    middleware: [rateLimit(RATE_LIMITS.sensitive)] as const,
    responses: {
        200: jsonResponse(PendingResponseSchema, 'Pending upload id'),
        400: errorResponse('Missing/oversized/undersized file, missing promptId, or unsupported type'),
        404: errorResponse('Prompt not found or not accepting replies'),
        500: errorResponse('Storage/persistence failure'),
    },
});

app.openapi(uploadPendingRoute, async (c) => {
    let formData: FormData;
    try {
        formData = await c.req.formData();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid multipart body'), 400);
    }

    const fileField = formData.get('file');
    const promptIdRaw = formData.get('promptId');

    if (!fileField || !(fileField instanceof File)) {
        return c.json(errorEnvelope(c, 'Missing "file" field'), 400);
    }
    if (typeof promptIdRaw !== 'string' || !promptIdRaw) {
        return c.json(errorEnvelope(c, 'Missing "promptId" field'), 400);
    }

    if (fileField.size > MAX_SIZE) {
        return c.json(errorEnvelope(c, 'File too large (max 25MB)'), 400);
    }
    if (fileField.size < MIN_SIZE) {
        return c.json(errorEnvelope(c, 'File too small'), 400);
    }

    const mimeType = fileField.type || 'audio/mp4';
    if (!ALLOWED_TYPES.has(mimeType)) {
        return c.json(errorEnvelope(c, `Unsupported audio type: ${mimeType}`), 400);
    }

    // Verify prompt is live before taking the upload — collapses the
    // abuse vector where an attacker POSTs garbage to create dangling
    // pending rows on nonexistent prompts.
    const prompt = await promptService.getPromptData(promptIdRaw);
    if (!prompt || prompt.record.status !== 'live') {
        return c.json(errorEnvelope(c, 'Prompt not found or not accepting replies'), 404);
    }

    const buffer = Buffer.from(await fileField.arrayBuffer());
    let pendingId: string;
    try {
        ({ pendingId } = await createPendingUpload({
            buffer,
            mimeType,
            promptId: promptIdRaw,
            ipHash: hashIp(extractClientIp(c.req.header('x-forwarded-for'))),
        }));
    } catch (err) {
        // Firebase Storage / Firestore write failure. Without this the
        // throw bubbles to the generic error handler as an opaque 500 and
        // the embed shows a bare "Upload failed" — log it with the
        // requestId + promptId so the real cause is diagnosable.
        logger.error(
            { err, requestId: c.get('requestId'), promptId: promptIdRaw },
            '[audio/upload-pending] createPendingUpload failed',
        );
        return c.json(errorEnvelope(c, 'Upload failed'), 500);
    }

    // Standard response envelope — the embed client unwraps `data.pendingId`
    // (ReplyDot.submitPendingEmbed). Must mirror the sibling `/audio/upload`
    // route's `{ success: true, data }` shape, not a bare `{ pendingId }`.
    return c.json({ success: true as const, data: { pendingId } }, 200);
});

export { app as audioUploadPendingRoute };
