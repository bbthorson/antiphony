import { createHash, randomUUID } from 'crypto';
import admin from 'firebase-admin';
import { getAdminDb } from './firebase-admin.js';
import { StorageService } from '../services/core-services-firebase.js';
import { logger } from './logger.js';

/**
 * Pending-upload resolve/consume helpers.
 *
 * Ports the minimal subset of `apps/web/src/services/pending-uploads.ts`
 * that `POST /api/v1/replies` needs:
 *   - `resolvePendingUpload(pendingId, expectedPromptId)` — look up and
 *     verify a pending row
 *   - `consumePendingUpload(pendingId)` — best-effort cleanup after a
 *     reply has bound the audio
 *
 * The companion `createPendingUpload` + `POST /uploads/pending` route
 * belongs to the hosted-embed surface; ported separately alongside the
 * public upload endpoint.
 *
 * Shape matches apps/web — same Firestore collection (`pending_uploads`),
 * same 10-minute TTL, same promptId-scoping. Matters so apps/web and
 * core-api can resolve each other's pendings during the rollout window.
 */

export const PENDING_UPLOADS_COLLECTION = 'pending_uploads';
export const PENDING_UPLOAD_TTL_MS = 10 * 60 * 1000;

export interface PendingUpload {
    id: string;
    storagePath: string;
    audioUrl: string;
    mimeType: string;
    sizeBytes: number;
    promptId: string;
    ipHash: string;
    createdAt: Date;
    expiresAt: Date;
}

/**
 * Look up a pending upload and verify it's bindable: exists, not
 * expired, and matches the expected prompt. Returns null (not an error)
 * on any miss so the caller can surface a friendly 404.
 *
 * Does NOT delete. Binding succeeds first, then `consumePendingUpload`
 * cleans up — avoids losing the upload on a transient reply-create failure.
 */
export async function resolvePendingUpload(
    pendingId: string,
    expectedPromptId: string,
): Promise<PendingUpload | null> {
    const snap = await getAdminDb()
        .collection(PENDING_UPLOADS_COLLECTION)
        .doc(pendingId)
        .get();

    if (!snap.exists) return null;

    const data = snap.data() as
        | (Omit<PendingUpload, 'createdAt' | 'expiresAt'> & {
              createdAt: admin.firestore.Timestamp;
              expiresAt: admin.firestore.Timestamp;
          })
        | undefined;
    if (!data) return null;

    // PromptId mismatch: pending-upload rebinding attempt. Refuse.
    if (data.promptId !== expectedPromptId) return null;

    const expiresAt = data.expiresAt.toDate();
    if (expiresAt.getTime() < Date.now()) return null;

    return {
        ...data,
        id: snap.id,
        createdAt: data.createdAt.toDate(),
        expiresAt,
    };
}

/**
 * Delete a pending upload doc after successful bind. Errors during
 * cleanup are logged but not thrown — the reply already succeeded and
 * the TTL sweep (scheduled cleanup job in apps/web/functions) will
 * collect any orphans.
 */
export async function consumePendingUpload(pendingId: string): Promise<void> {
    try {
        await getAdminDb()
            .collection(PENDING_UPLOADS_COLLECTION)
            .doc(pendingId)
            .delete();
    } catch (err) {
        logger.error(
            { err, pendingId },
            '[pending-uploads] consume failed — TTL sweep will collect orphan',
        );
    }
}

/**
 * SHA-256 of the client IP, truncated to 16 hex chars — just enough
 * signal for abuse forensics without retaining raw addresses.
 */
export function hashIp(ip: string): string {
    return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

function mimeTypeToExtension(mime: string): string {
    switch (mime) {
        case 'audio/m4a':
        case 'audio/x-m4a':
        case 'audio/mp4':
            return 'm4a';
        case 'audio/mpeg':
            return 'mp3';
        case 'audio/webm':
            return 'webm';
        case 'audio/ogg':
            return 'ogg';
        case 'audio/wav':
            return 'wav';
        default:
            return 'm4a';
    }
}

/**
 * Write a pending upload: stores the audio blob under `pending/{id}.{ext}`
 * and records a doc in `pending_uploads/{id}` with a 10-minute TTL.
 *
 * Returns the pendingId the caller should pass to the iframe's parent
 * (via window.postMessage or a ?pending= redirect).
 *
 * Scoped to a specific promptId — the reply-create endpoint refuses
 * a pending that targets a different prompt.
 */
export async function createPendingUpload(input: {
    buffer: Buffer;
    mimeType: string;
    promptId: string;
    ipHash: string;
}): Promise<{ pendingId: string }> {
    const pendingId = `pend_${randomUUID()}`;
    const ext = mimeTypeToExtension(input.mimeType);
    const storagePath = `pending/${pendingId}.${ext}`;

    const audioUrl = await StorageService.uploadFile(
        input.buffer,
        storagePath,
        input.mimeType,
    );

    const now = new Date();
    const expiresAt = new Date(now.getTime() + PENDING_UPLOAD_TTL_MS);

    await getAdminDb()
        .collection(PENDING_UPLOADS_COLLECTION)
        .doc(pendingId)
        .set({
            id: pendingId,
            storagePath,
            audioUrl,
            mimeType: input.mimeType,
            sizeBytes: input.buffer.byteLength,
            promptId: input.promptId,
            ipHash: input.ipHash,
            createdAt: admin.firestore.Timestamp.fromDate(now),
            expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
        });

    return { pendingId };
}

// Re-export from the shared helper — single source of truth across the
// rate-limit middleware and pending-uploads.
export { extractClientIp } from './client-ip.js';
