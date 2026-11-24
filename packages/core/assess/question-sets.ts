import type { AssessmentOption, AssessmentSetRef } from 'shared/types/audio';

/**
 * Named question sets for the `assess` enrichment stage (`specs/assess-stage.md`).
 *
 * Questions live in core because they are product definitions and name no
 * vendor: any `AssessorPort` adapter asks the same questions. `version` is
 * stored on every `dev.antiphony.audio.assessment` record so a prompt edit is
 * distinguishable from a model change.
 */

export interface AssessQuestion {
    /** Stable question id; becomes the answer key on the assessment record. */
    readonly id: string;
    /** The question as the model reads it. */
    readonly prompt: string;
    readonly kind: 'boolean' | 'choice' | 'score';
    /** Allowed choice values (choice questions only). */
    readonly options?: readonly string[];
    /** Inclusive `[min, max]` integer scale (score questions only). */
    readonly range?: readonly [number, number];
    /** When `'reply'`, omitted on non-reply posts rather than answered `'no'`. */
    readonly appliesTo?: 'any' | 'reply';
}

export interface AssessQuestionSet {
    readonly name: string;
    /** Bumped whenever any question prompt or option list changes. */
    readonly version: number;
    readonly questions: readonly AssessQuestion[];
}

export const QUALITY_SET: AssessQuestionSet = {
    name: 'quality',
    version: 1,
    questions: [
        {
            id: 'quality.speech',
            prompt: 'Does this audio transcript contain intelligible human speech?',
            kind: 'boolean',
            appliesTo: 'any',
        },
        {
            id: 'quality.intelligible',
            prompt: 'How clearly can a listener follow what is being said (1 = unintelligible, 5 = completely clear)?',
            kind: 'score',
            range: [1, 5],
            appliesTo: 'any',
        },
        {
            id: 'quality.substantive',
            prompt: 'Does this contain substantive content beyond a greeting, mic test, or false start?',
            kind: 'boolean',
            appliesTo: 'any',
        },
    ],
};

export const RELEVANCE_SET: AssessQuestionSet = {
    name: 'relevance',
    version: 1,
    questions: [
        {
            id: 'relevance.answers',
            prompt: 'Does the reply respond to the prompt?',
            kind: 'choice',
            options: ['yes', 'partly', 'no'],
            appliesTo: 'reply',
        },
        {
            id: 'relevance.on_topic',
            prompt: "How closely does the reply stay on the prompt's subject (1 = completely off-topic, 5 = directly on-topic)?",
            kind: 'score',
            range: [1, 5],
            appliesTo: 'reply',
        },
    ],
};

export const ASSESS_QUESTION_SETS: Readonly<Record<string, AssessQuestionSet>> = {
    quality: QUALITY_SET,
    relevance: RELEVANCE_SET,
};

/**
 * Resolve operator-configured set names to `AssessQuestionSet[]`.
 *
 * Per `specs/assess-stage.md` §2.1:
 *  - Default is `['quality']`.
 *  - A tenant pinned to `relevance` gets `quality` too.
 *  - Unknown names are ignored (caller logs at config parse time).
 */
export function resolveQuestionSets(names: readonly string[] | undefined): AssessQuestionSet[] {
    const resolved: AssessQuestionSet[] = [];
    const seen = new Set<string>();

    const add = (name: string): void => {
        const key = name.trim().toLowerCase();
        const set = ASSESS_QUESTION_SETS[key];
        if (!set || seen.has(set.name)) return;
        seen.add(set.name);
        resolved.push(set);
    };

    if (names && names.length > 0) {
        for (const n of names) add(n);
    }

    // Relevance always includes quality; empty falls back to quality.
    if (seen.has('relevance') && !seen.has('quality')) {
        resolved.unshift(QUALITY_SET);
    } else if (resolved.length === 0) {
        resolved.push(QUALITY_SET);
    }

    return resolved;
}

/**
 * Filter a list of question sets down to the questions applicable to a post.
 * On a non-reply post, `appliesTo: 'reply'` questions are omitted rather than
 * answered `'no'`, and sets that contribute no questions are omitted from `sets`.
 */
export function questionsForPost(
    sets: readonly AssessQuestionSet[],
    isReply: boolean,
): { sets: AssessmentSetRef[]; questions: AssessQuestion[] } {
    const appliedSets: AssessmentSetRef[] = [];
    const questions: AssessQuestion[] = [];

    for (const set of sets) {
        const applicable = set.questions.filter((q) => q.appliesTo !== 'reply' || isReply);
        if (applicable.length === 0) continue;
        appliedSets.push({ name: set.name, version: set.version });
        questions.push(...applicable);
    }

    return { sets: appliedSets, questions };
}

/**
 * Allowed option keys for a question in canonical order.
 * Booleans use `'true'` / `'false'`; scores use `'1'..'5'` (stringified ints).
 */
export function optionKeysOf(question: AssessQuestion): string[] {
    if (question.kind === 'boolean') return ['true', 'false'];
    if (question.kind === 'choice') return [...(question.options ?? [])];
    const [min, max] = question.range ?? [1, 5];
    const keys: string[] = [];
    for (let n = min; n <= max; n++) keys.push(String(n));
    return keys;
}

/**
 * Convert a probability distribution (`0..1` floats) into per-mille integers
 * (`0..1000`, ATProto data has no floats) using largest-remainder rounding so
 * normalized inputs sum cleanly to 1000 without exceeding 1000.
 */
export function toPerMilleDistribution(distribution: Record<string, number>): AssessmentOption[] {
    const entries = Object.entries(distribution);
    if (entries.length === 0) return [];

    const clamped = entries.map(([value, raw]) => ({
        value,
        prob: Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0,
    }));

    const sum = clamped.reduce((acc, e) => acc + e.prob, 0);
    const scale = sum > 0 ? 1000 / sum : 0;
    const targetTotal = sum > 0 ? 1000 : 0;

    const scaled = clamped.map((e, index) => {
        const exact = e.prob * scale;
        const floor = Math.floor(exact);
        return {
            value: e.value,
            index,
            floor,
            remainder: exact - floor,
        };
    });

    let remaining = targetTotal - scaled.reduce((acc, e) => acc + e.floor, 0);
    const byRemainder = [...scaled].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (let i = 0; i < byRemainder.length && remaining > 0; i++) {
        byRemainder[i]!.floor += 1;
        remaining -= 1;
    }

    return scaled.map((e) => ({
        value: e.value,
        probability: Math.max(0, Math.min(1000, e.floor)),
    }));
}
