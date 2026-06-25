import { getAdminDb } from '../../../lib/firebase-admin.js';
import type { CallForwardingDependencies } from '@antiphony/core/ports/call-forwarding-dependencies';

export type { CallForwardingDependencies };

/**
 * Firebase-wired `CallForwardingDependencies` binding for core-api — the
 * telephony SIP reverse-index lookups.
 *
 * Plan B B3' retired the per-user config CRUD; telephony's call-forwarding
 * config now lives on the connector-config primitive at
 * `connector_configs/{uid}/items/telephony`. These lookups query that store
 * via collection-group queries. No Twilio coupling — Twilio lives in
 * apps/telephony.
 *
 * See `specs/plan-b-connector-boundaries.md`.
 */

export const firebaseCallForwardingDependencies: CallForwardingDependencies = {
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
