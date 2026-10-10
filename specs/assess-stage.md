# The `assess` stage — typed judgements about a post

**Status:** 📝 proposal 2026-10-10. Nothing is built. Adds a fifth enrichment
stage to the pipeline in [`enrichment-pipeline.md`](./enrichment-pipeline.md),
selected through the seam in [`provider-selection.md`](./provider-selection.md),
and reported through [`enrichment-webhooks.md`](./enrichment-webhooks.md).

## The ask

| | |
|---|---|
| **Add** | A **derived** stage, `assess`, that answers a fixed set of typed questions about a post (is this speech, is it intelligible, does this reply answer its prompt) and stores the answers as a record. |
| **Provider** | Cloudflare's Clef decision models on Workers AI, through the `AI` binding `core-api` already has. Phase 1 reads the transcript with `@cf/cloudflare/clef-flash`; Phase 2 adds `@cf/cloudflare/clef-omni` reading the audio itself. |
| **Contract** | Additive: a new `processing.assess` opt-in key, a new `dev.antiphony.audio.assessment` record lifted into the post view, and `assess` added to the webhook `stage` values. Patch bump, `0.8.0` → `0.8.1`. |
| **Costs** | One port, one adapter, one record, one registry entry, the question-set definitions. No new service, no new vendor key, no new network hop past the binding. |
| **Does not** | Let a tenant send its own questions per request, apply moderation labels, gate or reject posts, or replace any existing stage. |

---

## 1. Why now

Cloudflare released Clef on 2026-10-01 and extended it with Clef-omni on
2026-10-09
([changelog](https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/),
[model page](https://developers.cloudflare.com/workers-ai/models/clef-omni/)).
Clef is a **decision model**: given a *state* (text, JSON, images, and for
Clef-omni WAV/MP3 audio and video) and up to 64 typed questions (boolean,
choice or score), it returns a probability for every allowed option of every
question. It produces no text and no audio.

That fits none of our four stages, and replaces nothing. What it makes cheap is
a kind of enrichment we have no stage for: **judgements**. Every one we would
want today could be built against a general LLM, but Clef changes the economics
and the shape enough to make it worth doing:

- **Typed output.** Probabilities per option, not prose to parse. The adapter
  maps a schema to a schema; there is no prompt-injection-shaped failure where a
  transcript talks the model into answering in the wrong format.
- **Cost.** Clef-flash is $0.038 per million input tokens and output is free. A
  one-minute voice reply transcribes to roughly 150–200 words, so a pass is on
  the order of 500 tokens with the questions: about **$0.00002 per post**.
  Clef-omni is $0.15 per million, with audio tokenized at a rate we have not
  measured (Phase 2 measures it).
- **Latency.** Text decisions return in the low hundreds of milliseconds
  (Clef median 152 ms at ~800 tokens). Irrelevant inside the queue consumer, but
  it means the stage adds nothing noticeable to time-to-`ready`.
- **Where it runs.** Through the Workers AI binding, like the Whisper
  transcriber (`apps/core-api/src/adapters/outbound/workers-ai/`). Audio never
  leaves Cloudflare and there is no key to hold.

## 2. What the stage answers

Questions come in **named sets**, defined in code and chosen per tenant by the
operator (§ 5). Not per request: see § 8.

### 2.1 Phase 1 sets

**`quality`** — any post.

| Question id | Type | Options |
| :--- | :--- | :--- |
| `quality.speech` | boolean | does the audio contain human speech |
| `quality.intelligible` | score 1–5 | can a listener follow what is said |
| `quality.substantive` | boolean | is there content beyond a greeting, test or false start ("testing, one two") |

**`relevance`** — replies only (`reply` present on the record).

| Question id | Type | Options |
| :--- | :--- | :--- |
| `relevance.answers` | choice | `yes`, `partly`, `no` — does the reply respond to the prompt |
| `relevance.on_topic` | score 1–5 | how closely it stays on the prompt's subject |

`relevance` is the one only Antiphony can offer cheaply: the call-and-response
pair is our data model. Its state is the reply's transcript plus the **parent**
post's `text` and, when it has one, the parent's transcript. A tenant pinned to
`relevance` gets `quality` too; on a non-reply post `relevance` questions are
omitted from the call, not answered `no`.

### 2.2 Why these and not moderation

`post.json` already states the line: "service moderation is the labeler layer,
not a field here." A moderation set would invite consumers to treat an
`assessment` as a verdict, which it is not — it is a probability from one model,
stored as provenance-carrying analysis like a transcript. Moderation questions
can be added as a set later, but **applying labels** from them belongs to a
labeler service and its own spec. Nothing in this stage hides, rejects or
reorders a post.

### 2.3 What a set definition is

```ts
// packages/core/assess/question-sets.ts
export interface AssessQuestion {
    id: string;                         // stable; becomes the answer key
    prompt: string;                     // the question as the model reads it
    kind: 'boolean' | 'choice' | 'score';
    options?: readonly string[];        // choice only
    range?: readonly [number, number];  // score only
    appliesTo?: 'any' | 'reply';
}
export interface AssessQuestionSet {
    name: string;
    version: number;                    // bumped when any prompt changes
    questions: readonly AssessQuestion[];
}
```

Questions live in **core**, because they are product definitions and name no
vendor: a GPT-backed adapter would ask the same questions. `version` is stored
on the record so a changed prompt is distinguishable from a changed model —
otherwise a reworded question silently shifts every downstream threshold.

## 3. Where it sits in the pipeline

### 3.1 Classification

| Stage | Class | Execution | Output |
| :--- | :--- | :--- | :--- |
| `assess` | derived | external API (Workers AI binding) | `dev.antiphony.audio.assessment` record |

Derived, so the recompute rule applies unchanged: when a byte-mutating stage
produces a new variant, `assess` goes back to `pending` (unless the request set
`reprocess: false`).

### 3.2 Ordering — the first derived stage with an input dependency

Today the derived stages are mutually independent: "neither reads the other's
artifact." Phase 1 `assess` reads the transcript, so it breaks that. The order
becomes:

**denoise → trim → transcribe → assess**, with **waveform** independent.

In `AudioProcessingService.process` that means the `assess` block runs after the
transcribe block and reads the transcript that block just saved (or the post's
current transcript when transcribe was not in this pass). The waveform block is
untouched.

The dependency also changes recompute: **a transcript that is recomputed
invalidates the assessment**, even when no byte-mutating stage ran (e.g. a
`PATCH` that re-requests `transcribe` with a different tenant model). So the
recompute set gains one rule: `transcribe` in the recompute set ⇒ `assess` in it
too, when `assess` was previously requested.

### 3.3 When there is no transcript

The stage cannot run without its input, and the honest states already exist:

- `assess` requested, `transcribe` neither requested nor `ready` →
  `resolveInitialProcessing` resolves `assess` to **`skipped`** at request time.
  This mirrors how an uncapable stage resolves today, and does not silently
  turn on transcription (and its cost) behind the caller's back.
- `transcribe` settles `failed` or `skipped` in the pass → `assess` settles the
  same way (`failed` / `skipped`), without calling the model.
- Transcript is empty (the post is silence) → `assess` **still runs**. "No
  speech" is exactly what `quality.speech` should report, and Clef answering it
  on an empty state is cheaper than a special case.

Phase 2's audio mode removes the dependency for a tenant on Clef-omni (§ 7).

### 3.4 Request surface

```ts
ProcessingRequestSchema = z.object({
    transcribe, denoise, trim, waveform,
    assess: z.boolean().optional(),   // new
    reprocess,
});
```

`PROCESSING_STAGES` gains `'assess'` (last), `DERIVED_STAGES` gains it, and
`ProcessingStageMapSchema` gains the key. `toProcessingView` already derives
from `PROCESSING_STAGES`, so the view picks it up with no edit there. Both
`createPost` and `reprocessPost` take `dev.antiphony.audio.defs#processingRequest`,
so the lexicon change is one optional key there.

## 4. The port

```ts
// packages/core/ports/assessor.ts
export interface AssessInput {
    /** The post's transcript text (Phase 1: required). */
    text: string;
    /** For replies: the prompt's text and transcript, when available. */
    parent?: { text?: string; transcript?: string };
    /** Audio, for adapters that read it (Phase 2). Never required by core. */
    audio?: { bytes: Uint8Array; mimeType: string; durationMs?: number };
    questions: readonly AssessQuestion[];
}

export interface AssessAnswer {
    /** Probability per option; sums to ~1. Booleans use 'true' / 'false'. */
    distribution: Record<string, number>;
    /** The option with the highest probability, for consumers that want one. */
    top: string;
}

export interface AssessResult {
    answers: Record<string, AssessAnswer>;   // keyed by AssessQuestion.id
    model: string;                            // provenance, per provider-selection § 3.1
}

export interface AssessorPort {
    assess(input: AssessInput): Promise<AssessResult>;
}
```

Two provider-policy points, both from `provider-selection.md`:

- **The model never crosses the port.** It is closed over at wiring time by a
  factory (`workersAiAssessor(modelOverride?)`), exactly like
  `workersAiTranscriber`. `model` on the result is a report, not an input.
- **Distributions are portable; Clef's wire shape is not.** The adapter maps
  `AssessQuestion` to Clef's System One `questions` map and maps its answers
  back. An adapter over a model without calibrated probabilities can return a
  one-hot distribution; the record does not care.

A missing answer for a question the adapter sent is an adapter error (stage
`failed`), not a partial record: a consumer comparing two assessments must be
able to rely on the same keys being present.

## 5. Provider selection and config

One registry entry list, per the established shape in
`apps/core-api/src/lib/provider-registry.ts`:

```ts
const ASSESSORS: ProviderEntry<AssessorPort>[] = [
    { name: 'workers-ai', available: () => !!workersAi(), acceptsModel: true,
      create: (model) => workersAiAssessor(model) },
    { name: 'stub', available: () => true, explicitOnly: true, create: () => stubAssessor },
];
```

| Variable | Meaning |
| :--- | :--- |
| `ANTIPHONY_ASSESSOR` | Deployment default provider (selection rules unchanged: unknown or unavailable ⇒ logged, stage unavailable, no fallback). |
| `ANTIPHONY_APP_ASSESSORS` | `appId:provider` per-tenant pin. |
| `WORKERS_AI_ASSESS_MODEL` | Adapter model, default `@cf/cloudflare/clef-flash`. Follows `<VENDOR>_<CAPABILITY>_MODEL`. |
| `ANTIPHONY_APP_ASSESS_MODELS` | `appId:model` per-tenant model. |
| `ANTIPHONY_APP_ASSESS_SETS` | `appId:set+set` — which question sets a tenant gets. Default `quality`. |

`ANTIPHONY_PROCESSING_STUB=true` wires `stubAssessor`, which answers every
question with a uniform distribution and `model: 'stub'`.

The default model is **Clef-flash, not Clef**. Its context window is now 24K
tokens, which a transcript plus a parent transcript will not approach for the
upload size we accept (25 MB). The adapter truncates `state` defensively and the
model also truncates long text itself; a truncated assessment is still an
assessment, so this is logged, not failed.

## 6. Output — a record, like the transcript

```json
{
  "lexicon": 1,
  "id": "dev.antiphony.audio.assessment",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["subject", "sets", "answers", "model", "createdAt"],
        "properties": {
          "subject": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
          "sets": { "type": "array", "items": { "type": "ref", "ref": "#setRef" } },
          "answers": { "type": "array", "items": { "type": "ref", "ref": "#answer" } },
          "model": { "type": "string" },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    },
    "setRef": { "type": "object", "required": ["name", "version"],
      "properties": { "name": { "type": "string" }, "version": { "type": "integer" } } },
    "answer": { "type": "object", "required": ["id", "top", "distribution"],
      "properties": {
        "id": { "type": "string" },
        "top": { "type": "string" },
        "distribution": { "type": "array", "items": { "type": "ref", "ref": "#option" } }
      } },
    "option": { "type": "object", "required": ["value", "probability"],
      "properties": { "value": { "type": "string" },
        "probability": { "type": "integer", "minimum": 0, "maximum": 1000,
          "description": "Per-mille. atproto data has no floats." } } }
  }
}
```

Choices, each with a reason:

- **Its own record, not a `ProcessingState` field.** It is client-facing output
  with provenance, the same as a transcript; `ProcessingState` holds internal
  variant fields only, and `toProcessingView` projects stages only.
- **Arrays, not maps keyed by question id.** atproto records cannot have
  open-ended object keys under a lexicon; `id` inside each element is the
  lexicon-friendly form.
- **Per-mille integers.** atproto's data model has no floats. 0–1000 is enough
  resolution for any threshold a consumer will set.
- **`subject` is a StrongRef**, so an assessment of superseded audio is
  identifiable the same way a stale transcript is.
- **One record per pass.** Recompute writes a new record; the view resolves
  which one to lift the same way it resolves transcripts.

`dev.antiphony.embed.audio#view` gains an optional `assessment`, next to its
`transcript`, lifted only when `processing.assess === 'ready'`.

## 7. Phase 2 — Clef-omni reads the audio

What it adds: judgements a transcript cannot carry — background noise, tone,
music, a second speaker, a clipped recording — and **no transcript
dependency**, so a tenant can assess without paying for transcription.

What it costs, and why it is a separate phase:

- **Codec.** Clef-omni accepts WAV or MP3. Uploads are webm/opus. The working
  bytes are MP3 only when ElevenLabs denoise ran in the chain. Otherwise the
  stage has to obtain an MP3 rendition from `apps/audio-rendition` — the same
  Cloud Run service that backs trim and waveform — which is one more network
  hop and a dependency on a GCP service from a stage that was meant to be
  Cloudflare-only.
- **Limits.** Clips are capped at 8 MiB and 300 seconds each, embedded (no URLs).
  Our upload cap is 25 MB, so long posts exceed it. Options: assess the first
  300 s, split into up to 4 clips (16 MiB total), or settle `failed`. Decide
  with real duration data from Vox Pop before building.
- **Unmeasured cost.** Audio is billed as input tokens at a rate the docs do not
  state per second. Measure it on a sample before choosing a default.

Shape: `AssessInput.audio` is already on the port (§ 4). The adapter sends audio
when its model is Clef-omni and the bytes are WAV/MP3, and sends the transcript
as `state` too when one exists. The `assess` capability check becomes "this
tenant's assessor can run on what this post will have", so a Clef-omni tenant
no longer resolves `assess` to `skipped` without a transcript.

Phase 2 also adds an `audio` question set (`audio.background_noise`,
`audio.multiple_speakers`, `audio.music`, `audio.clipped`).

## 8. Decisions worth stating

**Questions are ops config, not a request field.** Same reasoning as
per-request model choice in `provider-selection.md` § 5: a tenant naming
arbitrary questions on the deployment's binding is a cost surface, and makes
assessments incomparable across posts. A named set with a version is
comparable over time. If a tenant needs its own questions, it gets its own set
in code — a review, not a request field.

**No thresholds in core.** Core stores distributions. Whether 0.7 on
`relevance.answers = no` means "hide it" is the tenant's product decision, made
in its BFF — the boundary in [`core-bff-boundary.md`](./core-bff-boundary.md).
The `top` field is a convenience, not a verdict.

**Not used to drive other stages yet.** "Denoise only if noisy" is tempting
(it would cut ElevenLabs spend), but it needs Phase 2's audio questions and it
inverts the ordering — assess would have to run *before* the byte-mutating
chain. Out of scope; revisit after Phase 2 with numbers.

## 9. Contract and docs

Additive throughout, so **patch: `0.8.0` → `0.8.1`**, per
[`api-versioning.md`](./api-versioning.md) ("new optional stage keys … patch").

- `CHANGELOG.md`: `processing.assess`, the `assessment` record and its view
  field, `assess` as a webhook `stage` value.
- Webhook receivers that switch exhaustively on `stage` will see a new value.
  `enrichment-webhooks.md` lists `stage` as the four current names, so it
  gains `assess`, and both it and the CHANGELOG entry state that receivers
  must ignore stage values they do not know. That keeps a future sixth stage
  additive too.
- Docs: the enrichment page's stage table, the self-hosting configuration page
  (§ 5's variables), and the generated reference from `openapi.json`.
- `enrichment-pipeline.md`: stage taxonomy and ordering updated to five stages
  when this lands; this spec stays the decision record.

## 10. Tests

- `processing.test.ts`: `assess` is in `PROCESSING_STAGES` and
  `DERIVED_STAGES`; `toProcessingView` projects it.
- `audio-processing.test.ts` (core):
  - assess runs after transcribe and reads its transcript;
  - assess with no transcript requested resolves `skipped`;
  - transcribe `failed` ⇒ assess `failed` without calling the port;
  - a recomputed transcript re-marks assess `pending`;
  - `reprocess: false` leaves assess alone;
  - `relevance` questions are dropped for a non-reply post.
- Adapter: Clef response → `AssessResult` mapping, a missing answer throws, and
  probabilities convert to per-mille without exceeding 1000 in total by more
  than rounding.
- Registry: per-tenant pin, unknown provider disables, stub is explicit-only.
- Lexicon parity test covers the new record.

## 11. Open

- **Billing.** The second billable stage after `waveform`, so it adds weight to
  the deferred billing seam in `enrichment-pipeline.md` § Open. Still deferred
  for the same reason: one operator.
- **Phase 2 long-audio policy** (§ 7): truncate, split, or fail.
- **Calibration.** Clef's probabilities are reported as calibrated on its
  benchmarks, not on voice replies. Before a consumer thresholds on them, score
  a hand-labelled sample of Vox Pop replies and publish the numbers in the docs.
