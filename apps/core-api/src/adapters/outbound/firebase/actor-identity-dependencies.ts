import { getAdminDb } from '../../../lib/firebase-admin.js';
import { ActorIdentityRecordSchema, type ActorIdentityRecord } from 'shared/types/actor-identity';
import { logger } from '../../../lib/logger.js';
import type { ActorIdentityDependencies } from '@antiphony/core/ports/actor-identity-dependencies';

export type { ActorIdentityDependencies };

/**
 * Firebase-wired `ActorIdentityDependencies` binding. Owns its own
 * collection (`actor_identities`, doc id = actor id) — deliberately
 * separate from the legacy `users` collection (see the port docstring).
 */

function actorIdentitiesCollection() {
    return getAdminDb().collection('actor_identities');
}

export const firebaseActorIdentityDependencies: ActorIdentityDependencies = {
    async upsertIdentity(
        originAppId: string,
        actorId: string,
        fields: { did?: string; handle?: string },
    ): Promise<ActorIdentityRecord> {
        const updatedAt = new Date();
        // Merge write: an app re-asserting just a handle doesn't clear a
        // previously registered did, and vice versa.
        await actorIdentitiesCollection().doc(actorId).set(
            {
                originAppId,
                ...(fields.did !== undefined ? { did: fields.did } : {}),
                ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
                updatedAt,
            },
            { merge: true },
        );
        const snap = await actorIdentitiesCollection().doc(actorId).get();
        return ActorIdentityRecordSchema.parse({ id: actorId, ...snap.data() });
    },

    async getIdentity(originAppId: string, actorId: string): Promise<ActorIdentityRecord | null> {
        if (!actorId || !actorId.trim()) return null;
        const snap = await actorIdentitiesCollection().doc(actorId).get();
        if (!snap.exists) return null;
        const parsed = ActorIdentityRecordSchema.safeParse({ id: snap.id, ...snap.data() });
        if (!parsed.success) {
            logger.error(
                { docId: snap.id, issues: parsed.error.issues },
                '[actor-identity-deps] ActorIdentityRecord validation failed',
            );
            return null;
        }
        // Tenancy isolation, same rule as posts: cross-tenant is invisible.
        if (parsed.data.originAppId !== originAppId) return null;
        return parsed.data;
    },

    now(): Date {
        return new Date();
    },
};
