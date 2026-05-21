import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { StorageService } from '../../outbound/firebase/core-services-firebase.js';

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

const app = new Hono();

app.post('/', requireAuth(), rateLimit(RATE_LIMITS.hourly), async (c) => {
    const uid = c.get('viewerUid')!;

    let formData: FormData;
    try {
        formData = await c.req.formData();
    } catch {
        return c.json(
            {
                status: 'error',
                message: 'Expected multipart/form-data',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
        return c.json(
            {
                status: 'error',
                message: 'Missing "file" field',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    if (file.size > MAX_SIZE) {
        return c.json(
            {
                status: 'error',
                message: 'File too large (max 25MB)',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const mimeType = file.type || 'audio/mp4';
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

    const ext = EXT_MAP[mimeType] || 'm4a';
    const path = `audio/${uid}/${Date.now()}-${randomUUID()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    const audioUrl = await StorageService.uploadFile(buffer, path, mimeType);

    return c.json({ success: true, data: { audioUrl } });
});

export { app as audioUploadRoute };
