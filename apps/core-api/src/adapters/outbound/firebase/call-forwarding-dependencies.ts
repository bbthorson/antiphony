import { getAdminDb } from '../../../lib/firebase-admin.js';
import {
    CallForwardingConfigSchema,
    type CallForwardingConfig,
} from 'shared/types/records';
import type { CallForwardingDependencies } from '@vox-pop/core/ports/call-forwarding-dependencies';

export type { CallForwardingDependencies };

/**
 * Firebase-wired `CallForwardingDependencies` binding for core-api.
 *
 * Storage path: `users/{uid}/private_data/call_forwarding` — a single
 * doc per user under their private_data subcollection. Matches the
 * existing apps/web layout in `apps/web/src/services/ivr/forwarding.ts`;
 * this PR is the first half of the move (the data API), apps/web's
 * implementation is retired in PR-E3 / PR-E4.
 *
 * Scope: pure data CRUD. No Twilio coupling — Twilio lives in
 * apps/telephony/ (planned tier-2 service).
 *
 * See `specs/decoupling-migration.md` § Post-4a Roadmap — PR-E.
 */

const PRIVATE_DATA_DOC_ID = 'call_forwarding';

function configRef(uid: string) {
    return getAdminDb()
        .collection('users')
        .doc(uid)
        .collection('private_data')
        .doc(PRIVATE_DATA_DOC_ID);
}

export const firebaseCallForwardingDependencies: CallForwardingDependencies = {
    async getConfig(uid: string): Promise<CallForwardingConfig | null> {
        if (!uid || !uid.trim()) return null;
        const snap = await configRef(uid).get();
        if (!snap.exists) return null;

        // Runtime-validate the stored doc. Catches schema drift between
        // older docs (from apps/web's writes) and current Zod definitions
        // — surfaces at the API boundary instead of leaking malformed
        // data to callers.
        const parsed = CallForwardingConfigSchema.safeParse(snap.data());
        if (!parsed.success) {
            // Don't throw — the user may have a partial / migrating doc.
            // Return null so the caller (route → user) sees "no config";
            // the migration / fix path is separate.
            return null;
        }
        return parsed.data;
    },

    async saveConfig(uid: string, config: CallForwardingConfig): Promise<void> {
        await configRef(uid).set(config);
    },

    async updateConfig(uid: string, updates: Partial<CallForwardingConfig>): Promise<void> {
        // The service layer guarantees a non-empty `updates` (caller
        // intent), but Firestore's `update()` requires at least one
        // field — defensive check keeps the binding robust to future
        // refactors.
        if (Object.keys(updates).length === 0) return;
        await configRef(uid).update(updates);
    },

    async deleteConfig(uid: string): Promise<void> {
        await configRef(uid).delete();
    },

    now(): Date {
        return new Date();
    },
};
