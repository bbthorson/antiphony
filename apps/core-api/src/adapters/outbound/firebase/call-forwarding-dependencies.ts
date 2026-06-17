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
 * @deprecated (Plan B B3') Telephony now stores its config on the
 * connector-config primitive (`connector_configs/{uid}/items/telephony`), so:
 *   - `findUidByPhoneNumber` / `findUidByDedicatedNumber` are **re-pointed**
 *     to query that new location (the live SIP routing path).
 *   - the CRUD methods (`getConfig`/`saveConfig`/`updateConfig`/`deleteConfig`)
 *     still target the legacy `private_data/call_forwarding` doc but are now
 *     **orphaned** — the only callers (core-api's `/users/me/call-forwarding`
 *     route + `call-forwarding/by-uid`) are superseded by the connector-config
 *     control plane and slated for removal in a follow-up.
 *
 * See `specs/plan-b-connector-boundaries.md`.
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

        // Collection-group query across connector-config `items` subcollections
        // (Plan B B3' — telephony config now lives at
        // `connector_configs/{uid}/items/telephony`). We only want a routable
        // telephony config: phone match + verified + enabled. Verification state
        // is connector-owned and lives in `status.data`; the user-authored phone
        // and the routing fields are in `settings`. Requires the composite index
        // in `firestore.indexes.json`.
        const snap = await getAdminDb()
            .collectionGroup('items')
            .where('connectorType', '==', 'telephony')
            .where('settings.phoneNumber', '==', phoneNumber)
            .where('status.data.verificationStatus', '==', 'verified')
            .where('enabled', '==', true)
            .limit(1)
            .get();

        if (snap.empty) return null;

        // Path is `connector_configs/{uid}/items/telephony`; the uid is the
        // second segment.
        const parts = snap.docs[0].ref.path.split('/');
        return parts[1] ?? null;
    },

    async findUidByDedicatedNumber(voxpopNumber: string): Promise<string | null> {
        if (!voxpopNumber || !voxpopNumber.trim()) return null;

        // Paid-tier dedicated numbers are 1:1 with users — voxpopNumber is
        // unique per provisioned number. No `enabled` predicate here
        // intentionally: a paid-tier user might temporarily disable forwarding
        // but Twilio's still routing the call to their dedicated number; the IVR
        // can still answer "you've reached <user>, leave a message" rather than
        // route to a 404. Storage: `connector_configs/{uid}/items/telephony`.
        const snap = await getAdminDb()
            .collectionGroup('items')
            .where('connectorType', '==', 'telephony')
            .where('settings.voxpopNumber', '==', voxpopNumber)
            .where('settings.tier', '==', 'paid')
            .where('status.data.verificationStatus', '==', 'verified')
            .limit(1)
            .get();

        if (snap.empty) return null;
        const parts = snap.docs[0].ref.path.split('/');
        return parts[1] ?? null;
    },
};
