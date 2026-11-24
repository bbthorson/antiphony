import {
    optionKeysOf,
    type AssessQuestion,
} from '@antiphony/core/assess/question-sets';
import type {
    AssessAnswer,
    AssessInput,
    AssessorPort,
    AssessResult,
} from '@antiphony/core/ports/assessor';
import { logger } from '../../../lib/logger.js';
import { workersAi } from './binding.js';

/**
 * Cloudflare Clef on Workers AI — an `AssessorPort` running through the
 * Worker's own `AI` binding (`specs/assess-stage.md` §§4–5).
 *
 * Clef evaluates a `state` against a map of typed `questions` (`noul`,
 * `choice`, `score`) and returns calibrated probabilities per option in a
 * single non-autoregressive pass — no free-form text to parse.
 */

const DEFAULT_MODEL = '@cf/cloudflare/clef-flash';

/** `<VENDOR>_<CAPABILITY>_MODEL`, per `specs/provider-selection.md`. */
const MODEL_VAR = 'WORKERS_AI_ASSESS_MODEL';

/**
 * Defensive character ceiling for `state` (Clef-flash context is 24K tokens;
 * ~48K chars stays comfortably inside it even with 64 questions). Truncation
 * is logged, never failed — a truncated assessment is still an assessment.
 */
const MAX_STATE_CHARS = 48_000;

type ClefQuestion =
    | { type: 'noul'; instructions: string }
    | { type: 'choice'; instructions: string; criteria: Record<string, string> }
    | { type: 'score'; instructions: string; criteria: string[] };

export function workersAiAssessor(modelOverride?: string): AssessorPort {
    return {
        async assess(input: AssessInput): Promise<AssessResult> {
            const ai = workersAi();
            if (!ai) throw new Error('Workers AI binding (AI) is not bound');

            const model = modelOverride ?? (process.env[MODEL_VAR]?.trim() || DEFAULT_MODEL);
            const { state, truncated } = buildState(input);
            if (truncated) {
                logger.warn(
                    { model, maxChars: MAX_STATE_CHARS },
                    '[workers-ai] Clef state truncated to fit context window',
                );
            }

            const questions = toClefQuestions(input.questions);
            const raw = await ai.run(model, { state, questions });
            const answers = parseClefResponse(raw, input.questions, model);

            return { answers, model };
        },
    };
}

/** Exported for tests. Formats transcript (+ optional parent context) into Clef `state`. */
export function buildState(input: AssessInput): { state: string; truncated: boolean } {
    const sections: string[] = [];
    if (input.parent) {
        const parentParts: string[] = [];
        if (input.parent.text?.trim()) parentParts.push(input.parent.text.trim());
        if (input.parent.transcript?.trim()) parentParts.push(input.parent.transcript.trim());
        if (parentParts.length > 0) {
            sections.push(`Prompt:\n${parentParts.join('\n')}`);
        }
        sections.push(`Reply transcript:\n${input.text}`);
    } else {
        sections.push(input.text);
    }

    const full = sections.join('\n\n');
    if (full.length > MAX_STATE_CHARS) {
        return { state: full.slice(0, MAX_STATE_CHARS), truncated: true };
    }
    return { state: full, truncated: false };
}

/** Exported for tests. Maps core `AssessQuestion[]` to Clef's `questions` map. */
export function toClefQuestions(
    questions: readonly AssessQuestion[],
): Record<string, ClefQuestion> {
    const out: Record<string, ClefQuestion> = {};
    for (const q of questions) {
        if (q.kind === 'boolean') {
            out[q.id] = { type: 'noul', instructions: q.prompt };
        } else if (q.kind === 'choice') {
            const criteria: Record<string, string> = {};
            for (const opt of q.options ?? []) {
                criteria[opt] = opt;
            }
            out[q.id] = { type: 'choice', instructions: q.prompt, criteria };
        } else {
            const keys = optionKeysOf(q);
            out[q.id] = { type: 'score', instructions: q.prompt, criteria: keys };
        }
    }
    return out;
}

/**
 * Exported for tests. Maps Clef's response back to `Record<string, AssessAnswer>`.
 *
 * A missing answer for any requested question throws (settling the stage
 * `failed`) rather than emitting a partial assessment record (§4).
 */
export function parseClefResponse(
    raw: unknown,
    questions: readonly AssessQuestion[],
    model: string,
): Record<string, AssessAnswer> {
    const container = unwrapAnswerMap(raw);
    if (!container) {
        logger.error({ model }, '[workers-ai] unexpected Clef output shape');
        throw new Error(`Workers AI ${model} returned an unexpected shape`);
    }

    const answers: Record<string, AssessAnswer> = {};
    for (const q of questions) {
        const entry = container[q.id];
        if (entry === undefined || entry === null) {
            throw new Error(`Workers AI ${model} omitted answer for question "${q.id}"`);
        }
        const distribution = extractDistribution(entry, q, model);
        const top = topOptionOf(distribution);
        answers[q.id] = { distribution, top };
    }
    return answers;
}

function unwrapAnswerMap(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    if (isPlainRecord(rec.answers)) return rec.answers;
    if (isPlainRecord(rec.response)) {
        if (isPlainRecord(rec.response.answers)) return rec.response.answers;
        return rec.response;
    }
    if (isPlainRecord(rec.result)) {
        if (isPlainRecord(rec.result.answers)) return rec.result.answers;
        return rec.result;
    }
    return rec;
}

function isPlainRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function extractDistribution(
    entry: unknown,
    question: AssessQuestion,
    model: string,
): Record<string, number> {
    const keys = optionKeysOf(question);

    if (question.kind === 'boolean') {
        if (typeof entry === 'number' && Number.isFinite(entry)) {
            const p = clamp01(entry);
            return { true: p, false: 1 - p };
        }
        if (isPlainRecord(entry)) {
            if (typeof entry.probability === 'number' && Number.isFinite(entry.probability)) {
                const p = clamp01(entry.probability);
                return { true: p, false: 1 - p };
            }
            const map = isPlainRecord(entry.probabilities)
                ? entry.probabilities
                : isPlainRecord(entry.distribution)
                    ? entry.distribution
                    : undefined;
            if (map) {
                const pTrue = readNumber(map.true ?? map.yes);
                const pFalse = readNumber(map.false ?? map.no);
                if (pTrue !== undefined && pFalse !== undefined) {
                    return { true: clamp01(pTrue), false: clamp01(pFalse) };
                }
                if (pTrue !== undefined) {
                    const p = clamp01(pTrue);
                    return { true: p, false: 1 - p };
                }
            }
        }
        throw new Error(`Workers AI ${model} returned invalid noul answer for "${question.id}"`);
    }

    if (isPlainRecord(entry)) {
        const probs = entry.probabilities ?? entry.distribution;
        if (Array.isArray(probs) && probs.length === keys.length) {
            const dist: Record<string, number> = {};
            for (let i = 0; i < keys.length; i++) {
                const n = readNumber(probs[i]);
                if (n === undefined) {
                    throw new Error(
                        `Workers AI ${model} returned non-numeric probability for "${question.id}"`,
                    );
                }
                dist[keys[i]!] = clamp01(n);
            }
            return dist;
        }
        if (isPlainRecord(probs)) {
            const dist: Record<string, number> = {};
            for (const key of keys) {
                const n = readNumber(probs[key]);
                if (n === undefined) {
                    throw new Error(
                        `Workers AI ${model} omitted option "${key}" for "${question.id}"`,
                    );
                }
                dist[key] = clamp01(n);
            }
            return dist;
        }
    }

    throw new Error(`Workers AI ${model} returned invalid ${question.kind} answer for "${question.id}"`);
}

function readNumber(x: unknown): number | undefined {
    return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function clamp01(n: number): number {
    return Math.max(0, Math.min(1, n));
}

function topOptionOf(distribution: Record<string, number>): string {
    let bestKey = '';
    let bestVal = -1;
    for (const [key, val] of Object.entries(distribution)) {
        if (val > bestVal) {
            bestVal = val;
            bestKey = key;
        }
    }
    return bestKey;
}
