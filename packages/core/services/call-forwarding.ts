import {
    CallForwardingConfigSchema,
    type CallForwardingConfig,
} from 'shared/types/records';
import { NotFoundError } from 'shared/errors';
import type { CallForwardingDependencies } from '../ports/call-forwarding-dependencies';

/**
 * CallForwardingService manages the canonical call-forwarding config
 * record at Firestore `users/{uid}/private_data/call_forwarding`. Pure
 * data layer — no Twilio coupling.
 *
 * The Twilio orchestration (Carrier Insights lookup, dedicated-number
 * provisioning, IVR verification call) lives in `apps/telephony/` per
 * `specs/data-separation.md` § 5. apps/telephony/ calls this service
 * via core-api's HTTP surface after running its Twilio work.
 *
 * See `specs/decoupling-migration.md` § Post-4a Roadmap — PR-E.
 */
export class CallForwardingService {
    constructor(private readonly deps: CallForwardingDependencies) {}

    /**
     * Read a user's call-forwarding config. Returns null if none exists.
     */
    async getConfig(uid: string): Promise<CallForwardingConfig | null> {
        return this.deps.getConfig(uid);
    }

    /**
     * Create (or replace) a user's call-forwarding config. Stamps
     * `createdAt` (always fresh — overwrites previous if any) and
     * `updatedAt`. Returns the saved record.
     */
    async saveConfig(
        uid: string,
        // The caller supplies the fully-validated config from
        // apps/telephony/ (after its Twilio lookup + provisioning).
        // We omit `createdAt`/`updatedAt` because this service stamps them.
        input: Omit<CallForwardingConfig, 'createdAt' | 'updatedAt'>,
    ): Promise<CallForwardingConfig> {
        const now = this.deps.now();
        const record: CallForwardingConfig = {
            ...input,
            createdAt: now,
            updatedAt: now,
        };

        // Re-validate at the service boundary. The route handler already
        // safe-parses input from the wire, but apps/telephony/ may call
        // saveConfig in-process from a future server-to-server flow; the
        // re-parse is cheap and the safety net is worth it.
        const validated = CallForwardingConfigSchema.parse(record);

        await this.deps.saveConfig(uid, validated);
        return validated;
    }

    /**
     * Apply a partial update. Stamps `updatedAt` automatically. Throws
     * if no config exists for the user (matches the binding's behavior).
     * Returns the updated record on success.
     */
    async updateConfig(
        uid: string,
        // Same `Omit` shape as `saveConfig` — the caller can't override
        // timestamps.
        updates: Partial<Omit<CallForwardingConfig, 'createdAt' | 'updatedAt'>>,
    ): Promise<CallForwardingConfig> {
        const existing = await this.deps.getConfig(uid);
        if (!existing) {
            // Typed error — the core-api errorHandler middleware maps
            // ServiceError subclasses to their HTTP status, so the route
            // doesn't need to catch + remap manually.
            throw new NotFoundError('Call-forwarding config not found');
        }

        const now = this.deps.now();
        const merged: CallForwardingConfig = {
            ...existing,
            ...updates,
            updatedAt: now,
        };

        const validated = CallForwardingConfigSchema.parse(merged);
        await this.deps.updateConfig(uid, { ...updates, updatedAt: now });
        return validated;
    }

    /**
     * Delete a user's config. No-op if none exists. Does NOT release any
     * Twilio number associated with the config — that's
     * apps/telephony/'s responsibility (a Twilio API call, not a data
     * concern).
     */
    async deleteConfig(uid: string): Promise<void> {
        await this.deps.deleteConfig(uid);
    }
}
