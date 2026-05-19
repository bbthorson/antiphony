import type { CallForwardingConfig } from 'shared/types/records';

/**
 * Port for the call-forwarding data layer.
 *
 * The CallForwardingConfig record lives at Firestore
 * `users/{uid}/private_data/call_forwarding` in the default Firebase
 * binding. This interface is portable — alternative stores (Postgres
 * key-value, etc.) can implement it without changes to the service or
 * route handlers.
 *
 * Scope: pure CRUD on the config record. No Twilio coupling — the
 * canonical telephony orchestration (Twilio Carrier Insights lookup,
 * dedicated-number provisioning, IVR verification call) lives in
 * `apps/telephony/` (the planned tier-2 service per
 * `specs/data-separation.md` § 5). apps/telephony calls this data port
 * via core-api's HTTP surface to persist results of its Twilio work.
 *
 * See `specs/decoupling-migration.md` § Post-4a Roadmap — PR-E.
 */
export interface CallForwardingDependencies {
    /**
     * Read the user's call-forwarding config. Returns `null` if the user
     * has never set up forwarding.
     */
    getConfig(uid: string): Promise<CallForwardingConfig | null>;

    /**
     * Write the full config for a user. Idempotent — overwrites any
     * existing config. Caller is responsible for any "do not overwrite
     * an active config" guard at the orchestration layer (i.e. in
     * apps/telephony/'s user-facing setup endpoint).
     */
    saveConfig(uid: string, config: CallForwardingConfig): Promise<void>;

    /**
     * Apply a partial update. Used by apps/telephony/ to update
     * verification state (`verificationStatus`, `verificationAttempts`,
     * `lastVerificationAt`, `failureReason`, `enabled`) after running
     * the IVR verification flow. Throws if no config exists for the
     * user.
     */
    updateConfig(uid: string, updates: Partial<CallForwardingConfig>): Promise<void>;

    /**
     * Delete the config for a user. No-op if no config exists. The
     * dedicated Twilio number (if any) is NOT released here — that's
     * apps/telephony/'s responsibility (it's a Twilio API call, not a
     * data write).
     */
    deleteConfig(uid: string): Promise<void>;

    /**
     * Server-side clock for stamping `createdAt` / `updatedAt`. Lets
     * tests inject a deterministic clock.
     */
    now(): Date;

    /**
     * Find the uid of the user whose forwarding is configured for a
     * given inbound free-tier phone number. Used by SIP webhook
     * routing — the inbound caller's phone is matched against
     * `phoneNumber` on the active config. Only returns a match when
     * the config is `verificationStatus === 'verified'` AND
     * `enabled === true`; otherwise the inbound call should fall
     * through.
     *
     * Returns null when no match is found (the caller's number isn't
     * registered for forwarding) — NOT an error.
     */
    findUidByPhoneNumber(phoneNumber: string): Promise<string | null>;

    /**
     * Find the uid of the user assigned a given paid-tier dedicated
     * VoxPop number. The VoxPop number is the one Twilio routed the
     * inbound call to; finding the uid maps it back to the human
     * whose voicemail this is.
     *
     * Returns null when no match is found.
     */
    findUidByDedicatedNumber(voxpopNumber: string): Promise<string | null>;
}
