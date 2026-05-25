import admin from 'firebase-admin';
import { getAdminDb } from '../../../lib/firebase-admin.js';
import { ReplyRecordSchema, ReplyEnrichmentRecordSchema } from 'shared/types';
import { NotFoundError } from 'shared/errors';
import type { ReplyRecord, ReplyEnrichmentRecord } from 'shared/types';
import { logger } from '../../../lib/logger.js';

function promptsCollection() {
    return getAdminDb().collection('prompts');
}

function activitiesCollection() {
    return getAdminDb().collection('activities');
}

// Firestore write batches cap at 500 operations per commit. Bulk methods
// chunk against this limit. Same constant as other bindings.
const FIRESTORE_BATCH_LIMIT = 500;

// Firestore getAll() caps at 1000 refs per call.
const FIRESTORE_GETALL_LIMIT = 1000;
import type {
    ReplyDependencies,
    ReplyQueryOptions,
    ReplyActivityRecord,
    AggregateDeltaAccumulator,
} from '@vox-pop/core/ports/replies-dependencies';
import {
    sentimentKey,
    promptAggregateUpdate,
    computeAggregateDelta,
} from '@vox-pop/core/ports/replies-dependencies';

export type { ReplyDependencies, ReplyQueryOptions, ReplyActivityRecord };

const increment = (delta: number) => admin.firestore.FieldValue.increment(delta);

/**
 * Firebase-wired `ReplyDependencies` binding for core-api.
 *
 * **Scope**: all methods implemented. Reply create
 * (`createReplyWithCounterIncrement` + `newReplyId` + `newActivityId`)
 * landed in A4.2 alongside `POST /api/v1/replies`.
 *
 * Sole Firestore binding for replies as of Phase 4a — the apps/web copy
 * was retired with the HTTP-transport flip (apps/web reads replies via
 * HTTP from core-api, not in-process Firestore). This file is the source
 * of truth for reply data-layer semantics.
 */

function repliesCollection() {
    return getAdminDb().collection('replies');
}

/**
 * Enrichments live in a sibling namespace from canonical records — see
 * specs/data-separation.md § 3. Path: `enrichments/replies/{replyId}`. The
 * intermediate `replies` segment is the document id under `enrichments`
 * (so the path resolves to a subcollection-style layout via a nested
 * collection name).
 */
function replyEnrichmentsCollection() {
    return getAdminDb().collection('enrichments').doc('replies').collection('items');
}

function parseReplyEnrichmentDoc(
    doc: FirebaseFirestore.DocumentSnapshot,
): ReplyEnrichmentRecord | null {
    const data = doc.data();
    if (!data) return null;
    const parsed = ReplyEnrichmentRecordSchema.safeParse({ id: doc.id, ...data });
    if (!parsed.success) {
        logger.error(
            { docId: doc.id, issues: parsed.error.format() },
            '[replies-deps] schema validation failed for reply enrichment',
        );
        return null;
    }
    return parsed.data;
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

    async updateReplyStatusWithAggregates(prevReply, nextStatus) {
        const db = getAdminDb();
        await db.runTransaction(async (t) => {
            const replyRef = repliesCollection().doc(prevReply.id);
            const replyDoc = await t.get(replyRef);
            if (!replyDoc.exists) {
                throw new NotFoundError(`Reply ${prevReply.id} not found.`);
            }
            const currentReplyData = replyDoc.data() ?? {};
            const currentStatus = (currentReplyData.status as string | undefined) ?? 'live';

            t.update(replyRef, { status: nextStatus });

            const aggregateDelta = computeAggregateDelta(
                currentStatus,
                nextStatus,
                currentReplyData.aiStatus,
                currentReplyData.sentiment,
                currentReplyData.engagementScore,
                increment,
            );
            if (!aggregateDelta) return;

            const promptRef = promptsCollection().doc(prevReply.promptId);
            t.update(promptRef, aggregateDelta);
        });
    },

    async bulkUpdateRepliesStatusWithAggregates(prevReplies, nextStatus) {
        if (prevReplies.length === 0) return;

        // Per-prompt aggregate deltas, computed from the caller-supplied prev
        // state. Skips replies that don't contribute (no AI enrichment, or
        // archived ↔ deleted moves that don't cross the live boundary).
        const deltasByPrompt = new Map<string, AggregateDeltaAccumulator>();
        for (const prev of prevReplies) {
            const wasLive = prev.status === 'live';
            const isLive = nextStatus === 'live';
            if (wasLive === isLive) continue;
            if (prev.aiStatus !== 'complete') continue;
            if (typeof prev.engagementScore !== 'number') continue;
            const sk = sentimentKey(prev.sentiment);
            if (!sk) continue;

            const sign = isLive ? 1 : -1;
            const acc = deltasByPrompt.get(prev.promptId) ?? {
                sumDelta: 0,
                countDelta: 0,
                positive: 0,
                neutral: 0,
                negative: 0,
            };
            acc.sumDelta += sign * prev.engagementScore;
            acc.countDelta += sign;
            acc[sk] += sign;
            deltasByPrompt.set(prev.promptId, acc);
        }

        const db = getAdminDb();
        let writesInBatch = 0;
        let batch = db.batch();
        const commits: Promise<unknown>[] = [];
        const flush = () => {
            if (writesInBatch > 0) commits.push(batch.commit());
            batch = db.batch();
            writesInBatch = 0;
        };

        for (const prev of prevReplies) {
            batch.update(repliesCollection().doc(prev.id), { status: nextStatus });
            writesInBatch++;
            if (writesInBatch >= FIRESTORE_BATCH_LIMIT) flush();
        }
        for (const [promptId, d] of deltasByPrompt) {
            batch.update(promptsCollection().doc(promptId), promptAggregateUpdate(d, increment));
            writesInBatch++;
            if (writesInBatch >= FIRESTORE_BATCH_LIMIT) flush();
        }
        flush();
        await Promise.all(commits);
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

    newReplyId() {
        return repliesCollection().doc().id;
    },

    newActivityId() {
        return activitiesCollection().doc().id;
    },

    async createReplyWithCounterIncrement(reply, activity) {
        const db = getAdminDb();
        await db.runTransaction(async (t) => {
            const promptRef = promptsCollection().doc(reply.promptId);
            const replyRef = repliesCollection().doc(reply.id);

            const promptDoc = await t.get(promptRef);
            if (!promptDoc.exists) {
                throw new NotFoundError(`Prompt ${reply.promptId} does not exist.`);
            }

            t.set(replyRef, reply);
            t.update(promptRef, {
                replyCount: admin.firestore.FieldValue.increment(1),
                lastReplyAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            if (activity) {
                t.set(activitiesCollection().doc(activity.id), activity);
            }
        });
    },

    now() {
        return new Date();
    },

    // --- Reply Enrichments (sibling namespace: enrichments/replies/items/{id}) ---

    async getReplyEnrichmentById(replyId) {
        const doc = await replyEnrichmentsCollection().doc(replyId).get();
        if (!doc.exists) return null;
        return parseReplyEnrichmentDoc(doc);
    },

    async getReplyEnrichmentsByIds(replyIds) {
        const map = new Map<string, ReplyEnrichmentRecord>();
        if (replyIds.length === 0) return map;

        // Chunk by Firestore getAll's 1000-ref cap.
        const refs = replyIds.map((id) => replyEnrichmentsCollection().doc(id));
        for (let i = 0; i < refs.length; i += FIRESTORE_GETALL_LIMIT) {
            const chunk = refs.slice(i, i + FIRESTORE_GETALL_LIMIT);
            const docs = await getAdminDb().getAll(...chunk);
            for (const doc of docs) {
                if (!doc.exists) continue;
                const parsed = parseReplyEnrichmentDoc(doc);
                if (parsed) map.set(doc.id, parsed);
            }
        }
        return map;
    },

    async updateReplyEnrichment(replyId, updates) {
        // `set` with `merge: true` so the doc is created on first write.
        await replyEnrichmentsCollection().doc(replyId).set(updates, { merge: true });
    },
};
