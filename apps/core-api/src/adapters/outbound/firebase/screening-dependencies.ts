import { getAdminDb } from '../../../lib/firebase-admin.js';
import { ScreeningRuleRecordSchema, type ScreeningRuleRecord } from 'shared/types/records';
import type { ScreeningRuleDependencies } from '@vox-pop/core/ports/screening-dependencies';
import { logger } from '../../../lib/logger.js';

export type { ScreeningRuleDependencies };

/**
 * Firebase-wired `ScreeningRuleDependencies` binding for core-api.
 *
 * Storage path: `users/{uid}/private_data/screening/rules/{ruleId}` — a
 * per-user `rules` subcollection under the `private_data/screening` doc,
 * matching the private_data convention used by call-forwarding + FCM tokens.
 * A list-per-user with `expiresAt` range needs (this is why it's a
 * subcollection, not a single doc). Pure data CRUD — no telephony coupling.
 *
 * See `specs/consumer-call-app.md` § 5.
 */
function rulesCollection(uid: string) {
    return getAdminDb()
        .collection('users')
        .doc(uid)
        .collection('private_data')
        .doc('screening')
        .collection('rules');
}

function parseRuleDoc(doc: FirebaseFirestore.DocumentSnapshot): ScreeningRuleRecord | null {
    const data = doc.data();
    if (!data) return null;
    const parsed = ScreeningRuleRecordSchema.safeParse({ id: doc.id, ...data });
    if (!parsed.success) {
        logger.error(
            { docId: doc.id, issues: parsed.error.format() },
            '[screening-deps] schema validation failed for screening rule',
        );
        return null;
    }
    return parsed.data;
}

export const firebaseScreeningDependencies: ScreeningRuleDependencies = {
    async listRules(uid: string): Promise<ScreeningRuleRecord[]> {
        if (!uid || !uid.trim()) return [];
        const snap = await rulesCollection(uid).orderBy('createdAt', 'desc').get();
        return snap.docs
            .map((d) => parseRuleDoc(d))
            .filter((r): r is ScreeningRuleRecord => r !== null);
    },

    async getRule(uid: string, ruleId: string): Promise<ScreeningRuleRecord | null> {
        const snap = await rulesCollection(uid).doc(ruleId).get();
        if (!snap.exists) return null;
        return parseRuleDoc(snap);
    },

    async createRule(uid: string, rule: ScreeningRuleRecord): Promise<void> {
        await rulesCollection(uid).doc(rule.id).set(rule);
    },

    async updateRule(uid: string, ruleId: string, updates: Partial<ScreeningRuleRecord>): Promise<void> {
        // Firestore's update() requires at least one field. The service always
        // sends a non-empty patch, but guard defensively.
        if (Object.keys(updates).length === 0) return;
        await rulesCollection(uid).doc(ruleId).update(updates);
    },

    async deleteRule(uid: string, ruleId: string): Promise<void> {
        await rulesCollection(uid).doc(ruleId).delete();
    },

    now(): Date {
        return new Date();
    },

    newId(): string {
        // Mint a random Firestore-style id without a write — `.doc()` with no
        // path generates one. Any collection ref works for id generation.
        return getAdminDb().collection('users').doc().id;
    },
};
