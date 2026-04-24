import admin from 'firebase-admin';
import { getAdminDb } from '../lib/firebase-admin.js';
import { ReplyRecordSchema } from 'shared/types';
import type { ReplyRecord } from 'shared/types';
import { logger } from '../lib/logger.js';

// Firestore write batches cap at 500 operations per commit. Bulk methods
// chunk against this limit. Same constant as other bindings.
const FIRESTORE_BATCH_LIMIT = 500;

// Firestore getAll() caps at 1000 refs per call.
const FIRESTORE_GETALL_LIMIT = 1000;
import type {
    ReplyDependencies,
    ReplyQueryOptions,
    ReplyActivityRecord,
} from '@vox-pop/core/services/replies-dependencies';

export type { ReplyDependencies, ReplyQueryOptions, ReplyActivityRecord };

/**
 * Firebase-wired `ReplyDependencies` binding for core-api.
 *
 * **Scope as of this PR**: read path + most write/update methods
 * (`queryByPromptId`, `queryByPromptIds`, `getReplyById`, `getRepliesByIds`,
 * `updateReply`, `bulkUpdateReplies`, `markReplyRead`, `bulkMarkRepliesRead`)
 * are implemented — backs the full reply-writes-except-create surface in
 * Batch A4. The reply-create transaction (`createReplyWithCounterIncrement`
 * + `newReplyId` + `newActivityId`) stays stubbed until Batch A4.2 ports
 * `POST /replies` alongside the pending-uploads module.
 *
 * Parity source: `apps/web/src/services/replies-dependencies.ts`. Logic is
 * mirrored directly; only imports differ (no `server-only`; pino not Winston).
 */

function repliesCollection() {
    return getAdminDb().collection('replies');
}

/**
 * Applies the data-layer filters used by all reply reads:
 *   - deleted replies are always excluded
 *   - archived replies are excluded unless explicitly requested
 *   - legacy records with no `status` but non-public `visibility` are excluded
 *     (pre-status-field visibility semantics)
 *
 * Filters operate on raw doc data (before schema parse) because the schema
 * defaults `status` to `'live'`, erasing the "no status" distinction after
 * parsing.
 */
function passesVisibilityFilter(
    data: FirebaseFirestore.DocumentData,
    includeArchived: boolean,
): boolean {
    if (data.status === 'deleted') return false;
    if (data.status === 'archived' && !includeArchived) return false;
    if (!data.status && data.visibility && data.visibility !== 'public') return false;
    return true;
}

function parseReplyDoc(
    doc: FirebaseFirestore.DocumentSnapshot | FirebaseFirestore.QueryDocumentSnapshot,
): ReplyRecord | null {
    const data = doc.data();
    if (!data) return null;
    const parsed = ReplyRecordSchema.safeParse({ id: doc.id, ...data });
    if (!parsed.success) {
        logger.error(
            { docId: doc.id, issues: parsed.error.format() },
            '[replies-deps] schema validation failed for reply',
        );
        return null;
    }
    return parsed.data;
}

const notYetPorted = (method: string): never => {
    throw new Error(
        `[core-api replies-dependencies] ${method} is not yet ported. See apps/core-api/src/services/replies-dependencies.ts and apps/web/src/services/replies-dependencies.ts for the binding to mirror.`,
    );
};

export const firebaseReplyDependencies: ReplyDependencies = {
    // --- Implemented: read paths for Batch A2 ---

    async queryByPromptId(promptId, options) {
        const includeArchived = options?.includeArchived ?? false;
        const snapshot = await repliesCollection()
            .where('promptId', '==', promptId)
            .orderBy('createdAt', 'desc')
            .get();

        const results: ReplyRecord[] = [];
        for (const doc of snapshot.docs) {
            const data = doc.data();
            if (!passesVisibilityFilter(data, includeArchived)) continue;
            const record = parseReplyDoc(doc);
            if (record) results.push(record);
        }
        return results;
    },

    async queryByPromptIds(promptIds, options) {
        if (promptIds.length === 0) return [];
        const includeArchived = options?.includeArchived ?? false;

        // Firestore `in` is capped at 30 values; chunk.
        const chunks: string[][] = [];
        for (let i = 0; i < promptIds.length; i += 30) {
            chunks.push(promptIds.slice(i, i + 30));
        }

        const allRecords: ReplyRecord[] = [];
        await Promise.all(
            chunks.map(async (chunk) => {
                const snap = await repliesCollection()
                    .where('promptId', 'in', chunk)
                    .get();
                for (const doc of snap.docs) {
                    const data = doc.data();
                    if (!passesVisibilityFilter(data, includeArchived)) continue;
                    const record = parseReplyDoc(doc);
                    if (record) allRecords.push(record);
                }
            }),
        );
        return allRecords;
    },

    // --- Implemented: read/update methods for Batch A4 ---

    async getReplyById(replyId) {
        if (!replyId || !replyId.trim()) return null;
        const doc = await repliesCollection().doc(replyId).get();
        if (!doc.exists) return null;
        return parseReplyDoc(doc);
    },

    async getRepliesByIds(replyIds) {
        if (replyIds.length === 0) return [];
        const db = getAdminDb();
        // Filter empty/whitespace ids before Firestore lookup — `doc('')`
        // throws at ref-construction time.
        const uniqueIds = Array.from(
            new Set(replyIds.filter((id) => id && id.trim())),
        );
        if (uniqueIds.length === 0) {
            return replyIds.map(() => null);
        }

        const chunks: string[][] = [];
        for (let i = 0; i < uniqueIds.length; i += FIRESTORE_GETALL_LIMIT) {
            chunks.push(uniqueIds.slice(i, i + FIRESTORE_GETALL_LIMIT));
        }
        const chunkResults = await Promise.all(
            chunks.map((chunk) =>
                db.getAll(...chunk.map((id) => repliesCollection().doc(id))),
            ),
        );
        const snapshots: FirebaseFirestore.DocumentSnapshot[] = chunkResults.flat();

        // Build a map so the return positionally aligns with the input
        // (including duplicates). Matches apps/web's contract.
        const map = new Map<string, ReplyRecord | null>();
        for (const snap of snapshots) {
            map.set(snap.id, snap.exists ? parseReplyDoc(snap) : null);
        }
        return replyIds.map((id) => map.get(id) ?? null);
    },

    async updateReply(replyId, updates) {
        await repliesCollection().doc(replyId).update(updates);
    },

    async bulkUpdateReplies(replyIds, updates) {
        if (replyIds.length === 0) return;
        for (let i = 0; i < replyIds.length; i += FIRESTORE_BATCH_LIMIT) {
            const chunk = replyIds.slice(i, i + FIRESTORE_BATCH_LIMIT);
            const batch = getAdminDb().batch();
            for (const id of chunk) {
                batch.update(repliesCollection().doc(id), updates);
            }
            await batch.commit();
        }
    },

    async markReplyRead(replyId, userId) {
        await repliesCollection().doc(replyId).update({
            readBy: admin.firestore.FieldValue.arrayUnion(userId),
        });
    },

    async bulkMarkRepliesRead(replyIds, userId) {
        if (replyIds.length === 0) return;
        for (let i = 0; i < replyIds.length; i += FIRESTORE_BATCH_LIMIT) {
            const chunk = replyIds.slice(i, i + FIRESTORE_BATCH_LIMIT);
            const batch = getAdminDb().batch();
            for (const id of chunk) {
                batch.update(repliesCollection().doc(id), {
                    readBy: admin.firestore.FieldValue.arrayUnion(userId),
                });
            }
            await batch.commit();
        }
    },

    // --- Stubbed — fill in when POST /replies ports (Batch A4.2) ---

    newReplyId() {
        return notYetPorted('newReplyId');
    },

    newActivityId() {
        return notYetPorted('newActivityId');
    },

    async createReplyWithCounterIncrement(_reply, _activity) {
        return notYetPorted('createReplyWithCounterIncrement');
    },

    now() {
        return new Date();
    },
};
