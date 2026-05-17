import { Hono } from 'hono';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { promptService } from '../../outbound/firebase/core-services-firebase.js';
import { createPendingUpload, hashIp, extractClientIp } from '../../../lib/pending-uploads.js';

/**
 * POST /api/v1/audio/upload-pending
 *
 * Anonymous audio upload endpoint for the embed-redirect flow: an iframe
 * records audio and POSTs here with `promptId` + `file` (multipart). We
 * rate-limit by IP, validate size / MIME / prompt existence, persist to
 * `pending/{id}.{ext}` + `pending_uploads/{id}`, and return `{ pendingId }`.
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

const app = new Hono();

app.post('/', rateLimit(RATE_LIMITS.sensitive), async (c) => {
    let formData: FormData;
    try {
        formData = await c.req.formData();
    } catch {
        return c.json(
            {
                status: 'error',
                message: 'Invalid multipart body',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const fileField = formData.get('file');
    const promptIdRaw = formData.get('promptId');

    if (!fileField || !(fileField instanceof File)) {
        return c.json(
            {
                status: 'error',
                message: 'Missing "file" field',
                requestId: c.get('requestId'),
            },
            400,
        );
    }
    if (typeof promptIdRaw !== 'string' || !promptIdRaw) {
        return c.json(
            {
                status: 'error',
                message: 'Missing "promptId" field',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    if (fileField.size > MAX_SIZE) {
        return c.json(
            {
                status: 'error',
                message: 'File too large (max 25MB)',
                requestId: c.get('requestId'),
            },
            400,
        );
    }
    if (fileField.size < MIN_SIZE) {
        return c.json(
            {
                status: 'error',
                message: 'File too small',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const mimeType = fileField.type || 'audio/mp4';
    if (!ALLOWED_TYPES.has(mimeType)) {
        return c.json(
            {
                status: 'error',
                message: `Unsupported audio type: ${mimeType}`,
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    // Verify prompt is live before taking the upload — collapses the
    // abuse vector where an attacker POSTs garbage to create dangling
    // pending rows on nonexistent prompts.
    const prompt = await promptService.getPromptData(promptIdRaw);
    if (!prompt || prompt.record.status !== 'live') {
        return c.json(
            {
                status: 'error',
                message: 'Prompt not found or not accepting replies',
                requestId: c.get('requestId'),
            },
            404,
        );
    }

    const buffer = Buffer.from(await fileField.arrayBuffer());
    const { pendingId } = await createPendingUpload({
        buffer,
        mimeType,
        promptId: promptIdRaw,
        ipHash: hashIp(extractClientIp(c.req.header('x-forwarded-for'))),
    });

    return c.json({ pendingId });
});

export { app as audioUploadPendingRoute };
