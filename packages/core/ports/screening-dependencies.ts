import type { ScreeningRuleRecord } from 'shared/types/records';

/**
 * Port for the screening-allowlist data layer.
 *
 * Rules live per-user at `users/{uid}/private_data/screening/rules/{ruleId}`
 * in the default Firebase binding. Pure CRUD over canonical user-authored
 * config (tier 1) — no telephony coupling. Evaluation/behavior (ring-through
 * vs async) is a Phase-2 capture-all concern that lives in apps/telephony;
 * this port only stores and reads rules. See `specs/consumer-call-app.md` § 5.
 */
export interface ScreeningRuleDependencies {
    /** All of a user's rules (newest-first by `createdAt`). */
    listRules(uid: string): Promise<ScreeningRuleRecord[]>;

    /** One rule by id, or null if absent. */
    getRule(uid: string, ruleId: string): Promise<ScreeningRuleRecord | null>;

    /** Persist a fully-formed rule (the service stamps id/ownerId/createdAt). */
    createRule(uid: string, rule: ScreeningRuleRecord): Promise<void>;

    /** Partial update of an existing rule. */
    updateRule(uid: string, ruleId: string, updates: Partial<ScreeningRuleRecord>): Promise<void>;

    /** Delete a rule. No-op if absent. */
    deleteRule(uid: string, ruleId: string): Promise<void>;

    /** Server-side clock for stamping `createdAt` (and expiry checks). */
    now(): Date;

    /** Generate a fresh, collision-free rule id. */
    newId(): string;
}
