import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from './firebase-admin.js';

/**
 * Per-viewer CRM notes + tags about a target person, keyed by handle.
 *
 * Storage path: `users/{viewerUid}/crm/{targetHandle}`. The data is
 * viewer-scoped — Alice's notes about @bob are not visible to anyone
 * else, including @bob. Matches the layout in the (now retired)
 * `apps/web/src/app/api/v1/people/[handle]/notes/route.ts`.
 *
 * Why this lives in a small standalone helper rather than a port +
 * service + binding triplet: the CRM-notes surface is two methods on
 * one collection; no other core service composes with it. The full
 * hexagonal split would be overkill. If/when CRM grows (tags
 * autocomplete, cross-handle search, enrichments-namespace migration
 * per `specs/data-separation.md` § 3), we lift this into a proper
 * service.
 */

export interface CrmNotes {
    notes: string;
    tags: string[];
}

export interface CrmNotesUpdate {
    notes?: string;
    tags?: string[];
}

function notesDocRef(viewerUid: string, targetHandle: string) {
    return getAdminDb()
        .collection('users')
        .doc(viewerUid)
        .collection('crm')
        .doc(targetHandle);
}

/**
 * Read the viewer's CRM notes about `targetHandle`. Returns
 * `{ notes: '', tags: [] }` if no entry exists — matches the prior
 * apps/web behavior (the UI relies on empty defaults rather than 404).
 */
export async function getCrmNotes(
    viewerUid: string,
    targetHandle: string,
): Promise<CrmNotes> {
    const doc = await notesDocRef(viewerUid, targetHandle).get();
    if (!doc.exists) {
        return { notes: '', tags: [] };
    }
    const data = doc.data() ?? {};
    return {
        notes: typeof data.notes === 'string' ? data.notes : '',
        tags: Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string') : [],
    };
}

/**
 * Update the viewer's CRM notes about `targetHandle`. Merge-write so
 * partial updates (just `notes`, just `tags`) don't blow away the
 * other field. Sets `lastUpdated` on every call via the Firestore
 * server timestamp.
 *
 * Callers should pre-validate `update.notes` (string) and
 * `update.tags` (string array) at the request boundary.
 */
export async function setCrmNotes(
    viewerUid: string,
    targetHandle: string,
    update: CrmNotesUpdate,
): Promise<void> {
    const payload: Record<string, unknown> = {
        lastUpdated: FieldValue.serverTimestamp(),
    };
    if (typeof update.notes === 'string') payload.notes = update.notes;
    if (Array.isArray(update.tags)) payload.tags = update.tags;

    await notesDocRef(viewerUid, targetHandle).set(payload, { merge: true });
}
