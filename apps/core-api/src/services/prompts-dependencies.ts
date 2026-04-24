import { getAdminDb } from '../lib/firebase-admin.js';
import { PromptDocumentSchema } from 'shared/types/storage';
import type { PromptDocument } from 'shared/types/storage';
import type { PromptRecord } from 'shared/types';
import { logger } from '../lib/logger.js';
import type {
    PromptDependencies,
    PromptQueryOptions,
    ActivityRecord,
} from '@vox-pop/core/services/prompts-dependencies';

export type { PromptDependencies, PromptQueryOptions, ActivityRecord };

/**
 * Firebase-wired `PromptDependencies` binding for core-api.
 *
 * **Scope as of this PR**: `getDocumentById` + `queryByAuthor` are
 * implemented — those are what `PromptService.getPromptData` and
 * `PromptService.getPromptsForUser` reach (transitively through
 * `services.hydration.hydratePrompt`). Every other method stays stubbed.
 *
 * Parity source: `apps/web/src/services/prompts-dependencies.ts`.
 */

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

const notYetPorted = (method: string): never => {
    throw new Error(
        `[core-api prompts-dependencies] ${method} is not yet ported. See apps/core-api/src/services/prompts-dependencies.ts and apps/web/src/services/prompts-dependencies.ts for the binding to mirror.`,
    );
};

export const firebasePromptDependencies: PromptDependencies = {
    // --- Implemented: getPromptData + getPromptsForUser paths ---

    async queryByAuthor(authorId: string, options?: PromptQueryOptions) {
        if (!authorId || !authorId.trim()) return [];
        const ref = promptsCollection();
        const q = await applyListQuery(ref.where('authorId', '==', authorId), options, ref);
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

    // --- Stubbed — fill in as endpoints port ---

    async queryByOrg(_orgId: string, _options?: PromptQueryOptions) {
        return notYetPorted('queryByOrg');
    },

    async getRecordById(_promptId: string) {
        return notYetPorted('getRecordById');
    },

    async getRecordsByIds(_promptIds: string[]) {
        return notYetPorted('getRecordsByIds');
    },

    newPromptId(): string {
        return notYetPorted('newPromptId');
    },

    async savePrompt(_record: PromptRecord & { replyCount: number }) {
        return notYetPorted('savePrompt');
    },

    async updatePrompt(_promptId: string, _updates: Partial<PromptRecord>) {
        return notYetPorted('updatePrompt');
    },

    newActivityId(): string {
        return notYetPorted('newActivityId');
    },

    async saveActivity(_activity: ActivityRecord) {
        return notYetPorted('saveActivity');
    },

    now(): Date {
        return new Date();
    },
};
