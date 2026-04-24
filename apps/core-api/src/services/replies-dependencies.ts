import { getAdminDb } from '../lib/firebase-admin.js';
import { ReplyRecordSchema } from 'shared/types';
import type { ReplyRecord } from 'shared/types';
import { logger } from '../lib/logger.js';
import type {
    ReplyDependencies,
    ReplyQueryOptions,
    ReplyActivityRecord,
} from '@vox-pop/core/services/replies-dependencies';

export type { ReplyDependencies, ReplyQueryOptions, ReplyActivityRecord };

/**
 * Firebase-wired `ReplyDependencies` binding for core-api.
 *
 * **Scope as of this PR**: read path for `getRepliesForPrompt` +
 * `getRepliesForPrompts` + `searchReplies` — which means `queryByPromptId`
 * and `queryByPromptIds` are implemented. Every write/mutation method
 * (`updateReply`, `bulkUpdateReplies`, `markReplyRead`, `bulkMarkRepliesRead`,
 * `createReplyWithCounterIncrement`, `newReplyId`, `newActivityId`) stays
 * stubbed and fills in when Batch A4 (reply writes) ports. `getReplyById`
 * and `getRepliesByIds` are also stubbed (reachable only via the write-tier
 * ownership checks).
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

    // --- Stubbed — fill in when reply writes (A4) port ---

    async getReplyById(_replyId) {
        return notYetPorted('getReplyById');
    },

    async getRepliesByIds(_replyIds) {
        return notYetPorted('getRepliesByIds');
    },

    newReplyId() {
        return notYetPorted('newReplyId');
    },

    async updateReply(_replyId, _updates) {
        return notYetPorted('updateReply');
    },

    async bulkUpdateReplies(_replyIds, _updates) {
        return notYetPorted('bulkUpdateReplies');
    },

    async markReplyRead(_replyId, _userId) {
        return notYetPorted('markReplyRead');
    },

    async bulkMarkRepliesRead(_replyIds, _userId) {
        return notYetPorted('bulkMarkRepliesRead');
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
