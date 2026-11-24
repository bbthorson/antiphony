import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    QUALITY_SET,
    RELEVANCE_SET,
    toPerMilleDistribution,
} from '@antiphony/core/assess/question-sets';
import { setWorkersAiForTest } from './binding.js';
import { buildState, parseClefResponse, toClefQuestions, workersAiAssessor } from './assessor.js';

const MODEL_VAR = 'WORKERS_AI_ASSESS_MODEL';
let savedModelVar: string | undefined;

beforeEach(() => {
    process.env.LOG_LEVEL = 'silent';
    savedModelVar = process.env[MODEL_VAR];
    delete process.env[MODEL_VAR];
    setWorkersAiForTest(undefined);
});

afterEach(() => {
    if (savedModelVar === undefined) delete process.env[MODEL_VAR];
    else process.env[MODEL_VAR] = savedModelVar;
    setWorkersAiForTest(undefined);
});

describe('workersAiAssessor', () => {
    it('maps Clef noul, choice, and score responses to AssessResult and uses default clef-flash model', async () => {
        const run = vi.fn(async () => ({
            answers: {
                'quality.speech': { probability: 0.92 },
                'quality.intelligible': { probabilities: [0.02, 0.03, 0.1, 0.25, 0.6] },
                'quality.substantive': { probability: 0.8 },
                'relevance.answers': { probabilities: { yes: 0.7, partly: 0.2, no: 0.1 } },
                'relevance.on_topic': { probabilities: { '1': 0.05, '2': 0.05, '3': 0.1, '4': 0.3, '5': 0.5 } },
            },
        }));
        setWorkersAiForTest({ run });

        const questions = [...QUALITY_SET.questions, ...RELEVANCE_SET.questions];
        const result = await workersAiAssessor().assess({
            text: 'My favorite book is Dune.',
            parent: { text: 'What is your favorite book?' },
            questions,
        });

        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0]![0]).toBe('@cf/cloudflare/clef-flash');
        expect(result.model).toBe('@cf/cloudflare/clef-flash');
        expect(result.answers['quality.speech']).toEqual({
            distribution: { true: 0.92, false: expect.closeTo(0.08, 6) },
            top: 'true',
        });
        expect(result.answers['relevance.answers']).toEqual({
            distribution: { yes: 0.7, partly: 0.2, no: 0.1 },
            top: 'yes',
        });
        expect(result.answers['quality.intelligible']!.top).toBe('5');

        // Verify per-mille conversion sums cleanly without exceeding 1000.
        for (const ans of Object.values(result.answers)) {
            const perMille = toPerMilleDistribution(ans.distribution);
            const total = perMille.reduce((acc, o) => acc + o.probability, 0);
            expect(total).toBe(1000);
            for (const o of perMille) {
                expect(Number.isInteger(o.probability)).toBe(true);
                expect(o.probability).toBeGreaterThanOrEqual(0);
                expect(o.probability).toBeLessThanOrEqual(1000);
            }
        }
    });

    it('honors modelOverride over WORKERS_AI_ASSESS_MODEL', async () => {
        process.env[MODEL_VAR] = '@cf/cloudflare/clef';
        const run = vi.fn(async () => ({
            answers: {
                'quality.speech': { probability: 0.9 },
            },
        }));
        setWorkersAiForTest({ run });

        const res = await workersAiAssessor('@cf/cloudflare/clef-omni').assess({
            text: 'hello',
            questions: [QUALITY_SET.questions[0]!],
        });
        expect(run.mock.calls[0]![0]).toBe('@cf/cloudflare/clef-omni');
        expect(res.model).toBe('@cf/cloudflare/clef-omni');
    });

    it('throws when Clef omits an answer for any requested question', () => {
        expect(() =>
            parseClefResponse(
                { answers: { 'quality.speech': { probability: 0.9 } } },
                QUALITY_SET.questions,
                '@cf/cloudflare/clef-flash',
            ),
        ).toThrow(/omitted answer for question "quality.intelligible"/);
    });

    it('truncates excessively long state defensively without failing', () => {
        const longText = 'a'.repeat(60_000);
        const { state, truncated } = buildState({
            text: longText,
            questions: QUALITY_SET.questions,
        });
        expect(truncated).toBe(true);
        expect(state.length).toBe(48_000);
    });

    it('maps core questions to Clef noul/choice/score schema', () => {
        const mapped = toClefQuestions([
            QUALITY_SET.questions[0]!,
            QUALITY_SET.questions[1]!,
            RELEVANCE_SET.questions[0]!,
        ]);
        expect(mapped['quality.speech']).toEqual({
            type: 'noul',
            instructions: QUALITY_SET.questions[0]!.prompt,
        });
        expect(mapped['quality.intelligible']).toEqual({
            type: 'score',
            instructions: QUALITY_SET.questions[1]!.prompt,
            criteria: ['1', '2', '3', '4', '5'],
        });
        expect(mapped['relevance.answers']).toEqual({
            type: 'choice',
            instructions: RELEVANCE_SET.questions[0]!.prompt,
            criteria: { yes: 'yes', partly: 'partly', no: 'no' },
        });
    });
});
