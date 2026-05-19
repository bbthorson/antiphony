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

    async findUidByPhoneNumber(phoneNumber: string): Promise<string | null> {
        if (!phoneNumber || !phoneNumber.trim()) return null;

        // Collection-group query across all `private_data` subcollections.
        // Path is `users/{uid}/private_data/call_forwarding`; we only care
        // about docs where phoneNumber matches AND the config is in a
        // routable state (verified + enabled). Other private_data docs
        // (none today, but the namespace is shared) would lack these
        // fields and would naturally fall out of the predicate.
        const snap = await getAdminDb()
            .collectionGroup('private_data')
            .where('phoneNumber', '==', phoneNumber)
            .where('verificationStatus', '==', 'verified')
            .where('enabled', '==', true)
            .limit(1)
            .get();

        if (snap.empty) return null;

        // Path is `users/{uid}/private_data/call_forwarding`; split out
        // the uid segment. Matches the pattern used in the pre-PR-E3
        // apps/web/src/services/ivr/forwarding.ts impl.
        const parts = snap.docs[0].ref.path.split('/');
        return parts[1] ?? null;
    },

    async findUidByDedicatedNumber(voxpopNumber: string): Promise<string | null> {
        if (!voxpopNumber || !voxpopNumber.trim()) return null;

        // Paid-tier dedicated numbers are 1:1 with users — voxpopNumber
        // is unique per provisioned number. No `enabled` predicate
        // here intentionally: a paid-tier user might temporarily
        // disable forwarding but Twilio's still routing the call to
        // their dedicated number; the IVR can still answer "you've
        // reached <user>, leave a message" rather than route to a 404.
        // Matches the pre-PR-E3 behavior in apps/web's
        // ivr/forwarding.ts.
        const snap = await getAdminDb()
            .collectionGroup('private_data')
            .where('voxpopNumber', '==', voxpopNumber)
            .where('tier', '==', 'paid')
            .where('verificationStatus', '==', 'verified')
            .limit(1)
            .get();

        if (snap.empty) return null;
        const parts = snap.docs[0].ref.path.split('/');
        return parts[1] ?? null;
    },
};
