import { getAdminDb } from '../../../lib/firebase-admin.js';
import { PromptDocumentSchema } from 'shared/types/storage';
import { PromptRecordSchema } from 'shared/types';
import type { PromptDocument } from 'shared/types/storage';
import type { PromptRecord } from 'shared/types';
import { logger } from '../../../lib/logger.js';
import type {
    PromptDependencies,
    PromptQueryOptions,
    ActivityRecord,
} from '@vox-pop/core/ports/prompts-dependencies';

export type { PromptDependencies, PromptQueryOptions, ActivityRecord };

function activitiesCollection() {
    return getAdminDb().collection('activities');
}

/**
 * Firebase-wired `PromptDependencies` binding for core-api.
 *
 * **Scope as of this PR**: all methods implemented except soft-delete
 * specifics. `newPromptId` + `savePrompt` + `updatePrompt` + `newActivityId`
 * + `saveActivity` back the prompt-write tier (Batch A5): POST /prompts,
 * DELETE /prompts/:id, PATCH /prompts/:id/status, POST /prompts/:id/read.
 *
 * Parity source: `apps/web/src/services/prompts-dependencies.ts`.
 */

// Firestore's `getAll()` caps at 1000 document refs per call. Chunk in
// `getRecordsByIds` to stay below the cap — matches the pattern in
// users-dependencies / organizations-dependencies.
const FIRESTORE_GETALL_LIMIT = 1000;

function promptsCollection() {
    return getAdminDb().collection('prompts');
}

async function applyListQuery(
    base: FirebaseFirestore.Query,
    options: PromptQueryOptions | undefined,
    collectionRef: FirebaseFirestore.CollectionReference,
): Promise<FirebaseFirestore.Query> {
    const { status = 'live-or-archived', limit = 20, cursorPromptId } = options ?? {};

    let q =
        status === 'live'
            ? base.where('status', '==', 'live')
            : base.where('status', 'in', ['live', 'archived']);

    q = q.orderBy('createdAt', 'desc').limit(limit);

    if (cursorPromptId) {
        const lastDocSnap = await collectionRef.doc(cursorPromptId).get();
        if (lastDocSnap.exists) {
            q = q.startAfter(lastDocSnap);
        }
    }

    return q;
}

function parseQueryResults(snapshot: FirebaseFirestore.QuerySnapshot): PromptDocument[] {
    const results: PromptDocument[] = [];
    for (const doc of snapshot.docs) {
        const parsed = PromptDocumentSchema.safeParse({ id: doc.id, ...doc.data() });
        if (!parsed.success) {
            logger.error(
                { docId: doc.id, issues: parsed.error.issues },
                '[prompts-deps] schema validation failed; skipping',
            );
            continue;
        }
        results.push(parsed.data);
    }
    return results;
}

export const firebasePromptDependencies: PromptDependencies = {
    // --- Implemented: getPromptData + getPromptsForUser paths ---

    async queryByAuthor(authorId: string, options?: PromptQueryOptions) {
        if (!authorId || !authorId.trim()) return [];
        const ref = promptsCollection();
        const q = await applyListQuery(ref.where('authorId', '==', authorId), options, ref);
        const snapshot = await q.get();
        return parseQueryResults(snapshot);
    },

    async queryByOrg(orgId: string, options?: PromptQueryOptions) {
        if (!orgId || !orgId.trim()) return [];
        const ref = promptsCollection();
        const q = await applyListQuery(ref.where('orgId', '==', orgId), options, ref);
        const snapshot = await q.get();
        return parseQueryResults(snapshot);
    },

    async getDocumentById(promptId: string) {
        if (!promptId || !promptId.trim()) return null;
        const docSnap = await promptsCollection().doc(promptId).get();
        if (!docSnap.exists) return null;
        const data = docSnap.data();
        if (!data) return null;
        return PromptDocumentSchema.parse({ id: docSnap.id, ...data });
    },

    async getRecordById(promptId: string) {
        if (!promptId || !promptId.trim()) return null;
        const docSnap = await promptsCollection().doc(promptId).get();
        if (!docSnap.exists) return null;
        const data = docSnap.data();
        if (!data) return null;
        return PromptRecordSchema.parse({ id: docSnap.id, ...data });
    },

    async getRecordsByIds(promptIds: string[]) {
        if (promptIds.length === 0) return [];
        const db = getAdminDb();
        // Filter empty/whitespace ids before Firestore lookup — `doc('')`
        // throws at ref-construction time, which would turn a mildly
        // malformed bulk request into an unhandled 500.
        const uniqueIds = Array.from(
            new Set(promptIds.filter((id) => id && id.trim())),
        );
        if (uniqueIds.length === 0) {
            return promptIds.map(() => null);
        }

        // Parallelize chunk lookups — matches the users-deps pattern. Most
        // inputs resolve in a single chunk; the parallelism matters only on
        // unusually wide bulk-action ownership checks.
        const chunks: string[][] = [];
        for (let i = 0; i < uniqueIds.length; i += FIRESTORE_GETALL_LIMIT) {
            chunks.push(uniqueIds.slice(i, i + FIRESTORE_GETALL_LIMIT));
        }
        const chunkResults = await Promise.all(
            chunks.map((chunk) =>
                db.getAll(...chunk.map((id) => promptsCollection().doc(id))),
            ),
        );
        const snapshots: FirebaseFirestore.DocumentSnapshot[] = chunkResults.flat();

        // Build a map so the return is positionally aligned with the input
        // (including duplicates). Callers rely on the positional contract.
        const map = new Map<string, PromptRecord | null>();
        for (const snap of snapshots) {
            if (!snap.exists) {
                map.set(snap.id, null);
                continue;
            }
            const data = snap.data();
            if (!data) {
                map.set(snap.id, null);
                continue;
            }
            const parsed = PromptRecordSchema.safeParse({ id: snap.id, ...data });
            if (!parsed.success) {
                logger.error(
                    { promptId: snap.id, issues: parsed.error.format() },
                    '[prompts-deps] PromptRecord schema validation failed',
                );
                map.set(snap.id, null);
                continue;
            }
            map.set(snap.id, parsed.data);
        }
        return promptIds.map((id) => map.get(id) ?? null);
    },

    newPromptId(): string {
        return promptsCollection().doc().id;
    },

    async savePrompt(record: PromptRecord & { replyCount: number }) {
        await promptsCollection().doc(record.id).set(record);
    },

    async updatePrompt(promptId: string, updates: Partial<PromptRecord>) {
        if (!promptId || !promptId.trim()) return;
        await promptsCollection().doc(promptId).update(updates);
    },

    newActivityId(): string {
        return activitiesCollection().doc().id;
    },

    async saveActivity(activity: ActivityRecord) {
        await activitiesCollection().doc(activity.id).set(activity);
    },

    now(): Date {
        return new Date();
    },
};
