# Enrichment pipeline (B5)

**Status:** ✅ implemented and deployed 2026-07-19 (proposed 2026-07-18). See
[`enrichment-pipeline-plan.md`](./enrichment-pipeline-plan.md) for the execution
record and per-step deviations. Extended the B5 processing scaffold already in
the tree (`packages/core/services/audio-processing.ts`, `packages/shared/types/processing.ts`,
the `processing` opt-in on `POST /api/v1/posts` + `PATCH /api/v1/posts/{postId}`) from two
stages to four, and settled stage ordering, the derived-artifact recompute rule, and the
provider seam. Companion to [`core-surface.md`](./core-surface.md) (what the contract exposes).

## What already exists

Not restated below, but load-bearing:

- **The provider seam.** `TranscriberPort` / `DenoiserPort` are pure interfaces in
  Firebase-free `@antiphony/core`; concrete providers live in outbound adapters and
  are selected off env in `resolveProviders()` (`apps/core-api/src/lib/audio-processing.ts`).
  The stub providers exercise the full create → process → hydrate loop with no secrets.
- **Denoise-before-transcribe ordering**, including the idempotent-retry case (a pass
  with denoise already `ready` starts from the cleaned variant rather than the noisy
  original).
- **The post-hoc trigger.** The `processing` opt-in on `PATCH /posts/{postId}` validates a
  stage request, persists it, and dispatches — the same seam as create.
- **Storage-layer processing state.** `ProcessingState` is deliberately outside the
  record CID, so stages can settle without changing a post's content address.

## Provider policy

The reference deployment wires **ElevenLabs** for both audio stages — Scribe for
transcription, Voice Isolator for denoise. One vendor, one API key, one adapter family.

This is a *deployment* choice, not a contract one. Nothing in `@antiphony/core` names
ElevenLabs; a self-hoster swapping in Whisper writes one adapter satisfying
`TranscriberPort` and changes nothing else. Keep it that way — provider-specific
concepts (voice ids, model names, vendor error codes) must not leak into the ports.

## Stage taxonomy

Four stages, classified on two independent axes. **Class** determines ordering and
recompute behavior; **execution** determines where a stage can be deployed
(see [Deployment portability](#deployment-portability)).

| Stage | Class | Execution | Output |
| :--- | :--- | :--- | :--- |
| `denoise` | byte-mutating | external API | contributes to the processed variant |
| `trim` | byte-mutating | local compute | contributes to the processed variant |
| `transcribe` | derived | external API | `dev.antiphony.audio.transcript` record |
| `waveform` | derived | local compute | normalized peaks on `ProcessingState` |

**Byte-mutating** stages produce new audio. They **compose in order into a single
variant** — trimmed-and-denoised audio is one artifact, not two. This replaces the
current single-purpose `denoisedBlobCid`.

**Derived** stages are pure analysis over audio they never modify. Because they are
derived, recomputation is always the correct response to their input changing.

## Ordering

**denoise → trim → (transcribe, waveform)**

All byte-mutating stages run first, in the order above; derived stages then consume
the final variant. The two derived stages are mutually independent and may run
concurrently.

Denoise precedes trim deliberately: silence detection keys off a noise floor, so on
noisy input the "silence" is not actually quiet and trim under-cuts. Denoising first
makes the silence genuinely silent and detection reliable.

Callers wanting a different order request stages **individually** via the `processing`
opt-in on `PATCH /posts/{postId}`, one call per stage. The order above is what a
multi-stage request runs; it is not a restriction on what callers may ask for.

## Recompute rule (decided)

Individual stage requests let a caller invalidate an artifact that already exists:
transcribe first, then denoise later, and the transcript describes audio that is no
longer what plays. Trim is worse — every transcript timestamp shifts, silently.

**Decision: auto-recompute.** When a byte-mutating stage completes and derived
artifacts already exist for the post, those derived stages are re-run against the new
variant. Derived artifacts are *defined* as a function of the variant, so a stale one
is a bug rather than a saving.

Consequences:

- A derived stage re-entering `pending` after having been `ready` is **normal**, not a
  regression. Clients already treat any `pending` stage as "still working"; that rule
  now also covers recompute.
- Recompute costs the caller money on a billable stage. `POST /processing` therefore
  accepts **`reprocess: false`** to suppress it — the caller keeps stale derivatives
  knowingly. Default is `true`.
- Recompute is bounded: byte-mutating stages do not depend on derived ones, so a
  recompute cannot itself trigger further byte-mutating work. No cascade.

## State model changes

`ProcessingStateSchema` (`packages/shared/types/processing.ts`):

- **`denoisedBlobCid` → `processedBlobCid`.** One variant CID for the composed output
  of all byte-mutating stages. The record's `embed.audio.ref.$link` stays the original,
  immutable content address; only the read-time view resolves to the variant.
- **`processedDurationMs`** — trim changes duration, and `embed.durationMs` lives inside
  the record CID and cannot be updated. The view prefers this when a variant exists.
- **`waveform`** — peaks for the processed variant, same reasoning as duration: the
  embed's client-supplied `waveform` is inside the CID and describes the original.
- **`trim` / `waveform`** stage keys alongside `transcribe` / `denoise`, in
  `ProcessingRequestSchema`, `ProcessingStateSchema`, and `ProcessingViewSchema`.

Hydration resolves per field: canonical values from the record, variant values from
`ProcessingState` when a processed variant exists. This generalizes the swap the view
already performs for playback URL.

Client-supplied `waveform` on the create embed **stays** — it is free, instant, and
correct for the common no-processing case. The `waveform` stage serves callers who
upload without a capture UI, and keeps peaks honest after byte-mutating stages run.

## Trim policy (decided)

**Fixed policy, conservative.** No caller-specified parameters — the smaller contract,
widened only on a real request.

- **Leading and trailing silence only.** Interior gaps are left alone: they carry
  conversational meaning (a pause before answering is content, not dead air), and
  removing them would desynchronize a listener's sense of the recording.
- **Conservative threshold.** Trim only what is unambiguously silence, and leave a
  short pad rather than cutting hard to the first sample of speech. An over-eager trim
  clipping a soft word onset is a far worse failure than a half-second of retained
  silence — the audio is the product, and the damage is unrecoverable.
- Concrete threshold and pad values are an implementation detail of the trim adapter,
  tuned against real recordings. They are not contract.

## Deployment portability

`apps/core-api` may move from Firebase App Hosting to Cloudflare. That decision is
**not gated on this pipeline**, and this pipeline should not bake in assumptions that
would block it. Two that would:

1. **Whole-blob-into-memory reads.** `readBlobBytes` returns a full `Uint8Array`.
   The lexicon caps audio at 100 MB, which exceeds the Workers memory ceiling. The
   dependency should be able to expose a stream, so a stage that does not need the
   whole buffer resident is not forced to materialize one.
2. **In-process audio decode.** The `local compute` stages (trim, waveform) decode
   audio in the worker process. On Workers those need a container or an external
   service; the `external API` stages (denoise, transcribe) are just HTTP and port
   as-is.

The `external API` / `local compute` axis in the stage taxonomy exists to make this
legible: it is the axis along which a stage's deployability varies, and it cuts across
the byte-mutating/derived split rather than aligning with it.

No migration work is implied here — the ports/adapters split already defers the
decision cheaply. This section exists so the pipeline does not quietly foreclose it.

## Open

- **Billing seam — deferred, not resolved.** The `waveform` stage is intended to be
  billable, and `reprocess: false` exists because recompute costs the caller money.
  But there is no metering or entitlement mechanism, and there is a boundary question
  behind it: metering looks like the calling app's concern under
  [`core-bff-boundary.md`](./core-bff-boundary.md), yet `reprocess: false` implies core
  knows a stage is billable. **Deliberately deferred** — the service has a single
  operator (its author) for the foreseeable term, so there is nothing to meter. Revisit
  before a second tenant is onboarded, not before the stage ships.
- **Cloud Tasks worker.** Still the outstanding piece from the original B5 scope
  (`ANTIPHONY_PROCESSING_INLINE` is dev/test only). Recompute makes the durable path
  more load-bearing: a recompute triggered by a later PATCH is exactly the work that
  should not run inline in a request. If the Cloudflare move is likely, this is the
  piece most worth building against a thin queue abstraction rather than Cloud Tasks
  directly — it is the one new component whose vendor coupling would otherwise be
  written from scratch on the losing side.
