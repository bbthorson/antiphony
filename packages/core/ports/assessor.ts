import type { AssessQuestion } from '../assess/question-sets';

/**
 * Outbound port for the `assess` enrichment stage (`specs/assess-stage.md` §4).
 *
 * The model never crosses this port — it is closed over at wiring time by the
 * adapter factory (e.g. `workersAiAssessor(modelOverride?)`), and `model` on
 * the result is provenance reported back by the adapter.
 */

export interface AssessInput {
    /** The post's transcript text (Phase 1: required; may be empty for silence). */
    text: string;
    /** For replies: the prompt's text and transcript, when available. */
    parent?: { text?: string; transcript?: string };
    /** Audio, for adapters that read it (Phase 2). Never required by core. */
    audio?: { bytes: Uint8Array; mimeType: string; durationMs?: number };
    questions: readonly AssessQuestion[];
}

export interface AssessAnswer {
    /** Probability per option (`0..1`); sums to ~1. Booleans use `'true'` / `'false'`. */
    distribution: Record<string, number>;
    /** The option with the highest probability, for consumers that want one. */
    top: string;
}

export interface AssessResult {
    /** Keyed by `AssessQuestion.id`. Every requested question MUST be present. */
    answers: Record<string, AssessAnswer>;
    /** Provenance: the concrete model/provider that produced these answers. */
    model: string;
}

export interface AssessorPort {
    assess(input: AssessInput): Promise<AssessResult>;
}
