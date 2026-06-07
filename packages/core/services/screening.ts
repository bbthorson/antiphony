import { ScreeningRuleRecordSchema, type ScreeningRuleRecord } from 'shared/types/records';
import { NotFoundError } from 'shared/errors';
import type { ScreeningRuleDependencies } from '../ports/screening-dependencies';

/**
 * Wire input for creating/updating a rule (post-validation shape from
 * `ScreeningRuleInputSchema` in `shared/api-codecs`). Kept as a local
 * interface so `packages/core` doesn't depend on the codec module; the route
 * safe-parses with the codec and hands the validated data straight in.
 * `expiresAt` is an ISO string or epoch-ms (or null = permanent).
 */
export interface ScreeningRuleInput {
    e164: string;
    label?: string | null;
    action: 'allow' | 'screen';
    expiresAt?: string | number | null;
}
export type ScreeningRuleUpdateInput = Partial<ScreeningRuleInput>;

/**
 * ScreeningService manages the canonical screening-allowlist records at
 * `users/{uid}/private_data/screening/rules/{ruleId}`. Pure data layer — the
 * ring-through-vs-async *evaluation* is Phase-2 capture-all behavior that
 * lives in apps/telephony. Under Phase-1 missed-call-only capture these rules
 * are foundational/editable but not yet gating. See
 * `specs/consumer-call-app.md` § 5.
 */
export class ScreeningService {
    constructor(private readonly deps: ScreeningRuleDependencies) {}

    /** List all of a user's rules. */
    async listRules(uid: string): Promise<ScreeningRuleRecord[]> {
        return this.deps.listRules(uid);
    }

    /**
     * Active (non-expired) rules as of `now`. Built for Phase-2 readiness
     * (the capture-all evaluator) — unused under missed-call-only capture, so
     * it has no caller yet. `expiresAt` is normalized to a Date by the schema,
     * so the comparison is a plain Date comparison.
     */
    async getActiveRules(uid: string, now: Date = this.deps.now()): Promise<ScreeningRuleRecord[]> {
        const all = await this.deps.listRules(uid);
        return all.filter((r) => !r.expiresAt || r.expiresAt > now);
    }

    /** Create a manual rule. Stamps id/ownerId/createdAt; source = 'manual'. */
    async createRule(uid: string, input: ScreeningRuleInput): Promise<ScreeningRuleRecord> {
        const record: ScreeningRuleRecord = {
            id: this.deps.newId(),
            ownerId: uid,
            e164: input.e164,
            label: input.label ?? null,
            action: input.action,
            source: 'manual',
            expiresAt: input.expiresAt != null ? new Date(input.expiresAt) : null,
            createdAt: this.deps.now(),
        };
        const validated = ScreeningRuleRecordSchema.parse(record);
        await this.deps.createRule(uid, validated);
        return validated;
    }

    /**
     * Partial update (label / action / e164 / expiresAt). Throws NotFoundError
     * if the rule doesn't exist. id / ownerId / source / createdAt are
     * immutable. Returns the updated record.
     */
    async updateRule(
        uid: string,
        ruleId: string,
        updates: ScreeningRuleUpdateInput,
    ): Promise<ScreeningRuleRecord> {
        const existing = await this.deps.getRule(uid, ruleId);
        if (!existing) {
            throw new NotFoundError('Screening rule not found');
        }

        const normalized: Partial<ScreeningRuleRecord> = {};
        if (updates.e164 !== undefined) normalized.e164 = updates.e164;
        if (updates.label !== undefined) normalized.label = updates.label ?? null;
        if (updates.action !== undefined) normalized.action = updates.action;
        if (updates.expiresAt !== undefined) {
            normalized.expiresAt = updates.expiresAt != null ? new Date(updates.expiresAt) : null;
        }

        const merged: ScreeningRuleRecord = { ...existing, ...normalized };
        const validated = ScreeningRuleRecordSchema.parse(merged);
        await this.deps.updateRule(uid, ruleId, normalized);
        return validated;
    }

    /** Delete a rule. No-op if it doesn't exist. */
    async deleteRule(uid: string, ruleId: string): Promise<void> {
        await this.deps.deleteRule(uid, ruleId);
    }
}
