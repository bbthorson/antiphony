# Enrichment pipeline — work plan

**Status:** active, opened 2026-07-18. Execution plan for
[`enrichment-pipeline.md`](./enrichment-pipeline.md) (the design). That doc is the
authority on *what* and *why*; this one is *in what order*, and is written to be
self-contained enough to resume from cold.

## Context you need

Read [`enrichment-pipeline.md`](./enrichment-pipeline.md) first. Condensed:

- Antiphony runs opt-in audio enrichment on posts. **Four stages**, on two axes:
  - **Class** (drives ordering + recompute): `denoise`/`trim` are **byte-mutating**,
    composing into one processed variant; `transcribe`/`waveform` are **derived**,
    pure analysis over the final variant.
  - **Execution** (drives deployability): `denoise`/`transcribe` are **external API**
    (ElevenLabs); `trim`/`waveform` are **local compute** (in-process decode).
- **Order:** denoise → trim → (transcribe, waveform). Denoise precedes trim because
  silence detection needs the noise floor gone first.
- **Auto-recompute:** when a byte-mutating stage completes and derived artifacts exist,
  re-run them. `reprocess: false` opts out.
- **Provider:** ElevenLabs (Scribe = transcription, Voice Isolator = denoise) for the
  reference deployment, behind the existing ports. **Not** the ElevenLabs CLI or MCP —
  both are Agents products, irrelevant here. Plain REST + API key.
- **Records are immutable.** `embed.audio.ref.$link`, `embed.durationMs`, and
  `embed.waveform` are inside the record CID and can never be updated. Everything a
  stage produces lives in storage-layer `ProcessingState`, and the *view* resolves
  between them.

### Already built — do not rebuild

- `TranscriberPort` / `DenoiserPort` (`packages/core/ports/`) — the provider seam.
- `AudioProcessingService.process()` (`packages/core/services/audio-processing.ts`) —
  denoise→transcribe ordering, idempotent retry, per-stage settle.
- `POST /api/v1/posts/{postId}/processing` (`apps/core-api/src/adapters/inbound/rest/posts.ts`,
  ~line 383) — the post-hoc stage-request seam.
- Stub providers (`apps/core-api/src/adapters/outbound/firebase/processing-providers.ts`)
  and env-based selection in `resolveProviders()` (`apps/core-api/src/lib/audio-processing.ts`).

### Production reality check

The `denoise` and `transcribe` adapters are wired (steps 2–3), and `trim`/`waveform`
still settle `skipped` until steps 5–6 give them ports. But **production enrichment
still does nothing**, for a different reason than it used to: dispatch.
`ANTIPHONY_PROCESSING_INLINE` is dev/test only, so **step 8 (durable dispatch) gates all
production enrichment.** Steps 2–7 are verifiable via inline mode; none of them are
shippable-to-prod without step 8.

## Versioning

Two independent axes, per [`api-versioning.md`](./api-versioning.md). Do not conflate.

**API contract** — `OPENAPI_INFO.version` in `apps/core-api/src/lib/openapi-info.ts`,
the single source of truth (`app.ts` imports it). Currently **0.3.0**. Pre-1.0 rules:
breaking → minor, additive/fix → patch.

Nearly everything here is **additive** (new optional stage keys, a new optional request
flag), so it is **patch** bumps and never forces `/v2`. One exception:

> **Step 7 is a minor bump.** Making the view resolve `durationMs`/`waveform` to the
> processed variant changes the meaning of existing fields — a consumer reads a
> different number for the same post. That is breaking under pre-1.0 rules even though
> no field is added or removed. `0.3.x` → `0.4.0`.

**Package versions** — track package releases, independent of the contract.
`@antiphony/shared` is at **0.4.0** and is the only published one; `core`, `core-api`,
and the root are `private` at `0.1.0` and can be left alone.

> **Step 1 bumps `@antiphony/shared` to 0.5.0.** Renaming the exported
> `denoisedBlobCid` → `processedBlobCid` is breaking for type consumers.

Per contract change, follow the existing checklist: bump `openapi-info.ts`, run
`npm run gen:openapi -w @antiphony/core-api`, commit the regenerated `openapi.json` +
`openapi.surface.json`, add a `CHANGELOG.md` entry, verify the docs redeploy after merge.

## The plan

One PR per step. Steps 2 and 3 are independent of each other; everything else is ordered.

### 1. State model refactor — *no behavior change* ✅ done 2026-07-18

Foundation; everything below depends on it.

- `packages/shared/types/processing.ts`: `denoisedBlobCid` → **`processedBlobCid`**; add
  **`processedDurationMs`** and **`waveformPeaks`**; add `trim` + `waveform` stage keys to
  `ProcessingRequestSchema`, `ProcessingStateSchema`, `ProcessingViewSchema`.
- Update `AudioProcessingService` and the Firebase dependencies to the renamed field.
- **Versions:** `@antiphony/shared` → 0.5.0 (breaking). Contract → 0.3.1 (additive).
- **Done when:** existing tests pass unchanged in behavior; no stage logic added yet.

**Deviations from the plan as written, and why:**

- **The peaks field is `waveformPeaks`, not `waveform`.** The plan asked for a `waveform`
  stage key *and* a `waveform` data field on the same `ProcessingStateSchema` object —
  they collide. The stage key keeps the bare name (consistent with the other three); the
  data field is `waveformPeaks`.
- **Added `ProcessingStageMap`** (all four statuses) to `shared/types/processing.ts`. The
  inline `{ transcribe?: …; denoise?: … }` literal was repeated in six places and would
  have doubled in width; `ProcessingState` and `ProcessingView` now both derive from it,
  and `toProcessingView()` is the one place internal fields are stripped.
- **`patchProcessingState` no longer allowlists fields.** The Firebase binding listed each
  patchable key by hand, so a key added to the schema but missed there would be dropped
  **silently** — the state would read `ready` while the artifact went nowhere. It now
  iterates the patch's own keys. Worth knowing before steps 5–6 add more output fields.
- **Capabilities report all four stages**, with `trim`/`waveform` hardcoded `false` until
  their ports exist. A requested stage with no runner resolves `skipped`, never a
  permanent `pending` that looks like work in flight.
- **`settlePendingAsSkipped` loops over `PROCESSING_STAGES`** rather than naming two
  stages, for the same reason.

### 2. ElevenLabs transcriber adapter ✅ done 2026-07-18

Narrowest real-provider slice; validates the port against a live API.

- New adapter satisfying `TranscriberPort`, calling ElevenLabs **Scribe** (plain REST).
- Selected in `resolveProviders()` off its API-key env var; stub stays for tests.
- Map real segment timings into `TimedTranscript`. Keep vendor concepts out of the port.
- **Versions:** none (no contract or exported-type change).
- **Done when:** inline mode produces a real transcript from real audio.
  ✅ Verified live: 3-sentence sample → 3 correctly-timed segments, schema-valid.

**Found only by the live call — the docs are wrong twice:**

- **Scribe returns ISO-639-3 (`eng`), not BCP-47.** The transcript lexicon specifies
  BCP-47 (`en`) and `lang` is a bare `z.string()`, so the raw code validates and would
  have been written into an immutable published record. Normalized at the adapter
  boundary via `Intl.getCanonicalLocales`, which also correctly leaves `yue`/`haw`
  alone (no two-letter form exists, so three letters already IS canonical). **No test
  would have caught this** — it is a contract violation the type system permits.
- **The isolation endpoint's documented response is wrong** (claims an empty JSON
  object for an endpoint that returns audio). Verify step 3 empirically; do not code
  to that page.

**Other decisions:**

- **Word timings are grouped into sentences.** Scribe returns per-WORD timings; one
  segment per word is schema-valid and useless to a caption renderer. Grouping is on
  sentence-final punctuation (incl. CJK forms — an ASCII-only check emits one segment
  for a whole Japanese clip) with a 12s hard cut so unpunctuated dictation cannot
  collapse into a single whole-clip segment. Adapter policy, not contract.
- **Provider selection is the key's presence alone** — no separate enable flag to drift
  out of sync with it. `ANTIPHONY_PROCESSING_STUB=true` still wins, so a key in the
  developer's shell cannot accidentally bill.
- **Env is test state.** `posts-processing.test.ts` has a "no provider ⇒ skipped" case
  that runs with the stub OFF — with a real key in the shell it would have resolved
  `pending` and fired a live billed call from `npm test`. Both test files now
  save/clear/restore `ELEVENLABS_API_KEY`. **Steps 3, 5, and 6 each add a provider and
  need the same treatment.**
- Live verification is a scratchpad script, deliberately not a vitest file: `npm test`
  must never bill anyone.

### 3. ElevenLabs denoiser adapter ✅ done 2026-07-18 — *bitrate deferred to step 5*

- New adapter satisfying `DenoiserPort`, calling **Voice Isolator**.
- Writes the cleaned variant via `writeDerivedBlob`, settles `processedBlobCid`.
- **Versions:** none.
- **Done when:** inline mode produces an audibly cleaned variant; original CID untouched.
  ✅ Mechanics verified live (real `voxpop` WebM → valid 6.09s MP3), and the output has
  since been listened to and confirmed audibly cleaned.

**The endpoint TRANSCODES — the finding that shaped this adapter:**

Whatever goes in, **MP3 (`audio/mpeg`) comes out**. Verified twice: WAV → MP3, and a
real WebM → MP3. The docs do not mention it (they describe the response as an empty
JSON object, which is simply wrong for an endpoint returning audio).

So the adapter reads `mimeType` from the RESPONSE and never echoes the input. Echoing
it — the obvious implementation, and what the pass-through stub correctly does — would
store MP3 bytes labelled `audio/webm`. Blobs are content-addressed and served to
browsers by signed URL **with their stored content type**, so that fails as silently
broken playback: no exception, no failed stage, nothing in the logs.

**Deferred to step 5: the output is 320 kbps CBR mono, and inflates storage ~2.5×.**

A 95 KB WebM came back as 239 KB MP3. Two costs:

- **Storage** grows ~2.5× for every denoised post, permanently (the original is kept —
  it is the record's immutable content address).
- **Quality**: Opus → MP3 is lossy-on-lossy generational loss. 320 kbps makes it about
  as good as re-encoding gets, but it is not free, and audio *is* the product.

Resolved by re-encoding locally in **step 5**, which needs an in-process decoder for
trimming anyway — that shared decode is what makes the re-encode cheap. It does pull in
the in-process audio decode that § Deployment portability warns blocks a Cloudflare move.
**Not blocking steps 4–7.**

Also note: **the lexicon caps audio at 100 MB**, and a 100 MB upload could exceed
250 MB after isolation. The variant is a derived blob and not itself bound by the
lexicon cap, but it interacts with the whole-blob-into-memory concern in
`enrichment-pipeline.md` § Deployment portability.

**Deviations, and one cost deferred to step 5:**

- **The documented response shape is wrong.** [The docs](https://elevenlabs.io/docs/api-reference/audio-isolation/convert)
  specify `application/json` with an empty body; the endpoint actually returns audio
  bytes. The adapter reads the mimeType off the *response* rather than assuming one, and
  throws on an empty body.
- **The form field is `audio`**, not `file` as in Scribe. The two endpoints differ.
- **Voice Isolator transcodes to 320kbps MP3 regardless of input — ~2.5× storage
  inflation, and there is no way to avoid it at the API.** The only format parameter,
  `file_format`, describes the *input* (`pcm_s16le_16` for lower latency). Re-encoding is
  therefore a local concern; **deferred to step 5**, which brings in an in-process decode
  dependency anyway. Doing it sooner would mean adding a codec solely for a size fix.

### 4. Auto-recompute ✅ done 2026-07-18

Needs ≥2 stages real (2 and 3) to be meaningful.

- In `AudioProcessingService`: when a byte-mutating stage completes and derived artifacts
  exist, mark those derived stages `pending` and re-run against the new variant.
- Add **`reprocess`** (optional, default `true`) to the processing request; `false`
  suppresses recompute.
- Assert the no-cascade property in a test: byte-mutating stages never depend on derived
  ones, so recompute cannot retrigger byte-mutating work.
- **Versions:** contract → patch (additive optional field). Shipped as **0.3.2**.
- **Done when:** transcribe-then-denoise leaves a transcript of the *cleaned* audio.
  ✅ Verified by test, not against the live API — see the open item below.

**A derived stage with no runner keeps `ready`; it is never downgraded.**

Steps 5–7 inherit this rule, step 6 most directly. When a variant changes and a derived
stage is `ready` but this deployment has no runner for it, the stage is **excluded from
the recompute set** rather than marked `pending`. Marking it would settle it `skipped`
— "never attempted" — while the artifact it already produced stays saved and readable.
The state would be strictly less true than leaving it alone. Same end state as
`reprocess: false`, reached for a different reason.

Consequences worth knowing before adding a derived stage:

- **`ready` does not imply fresh.** In this one case it means "produced once, possibly
  against superseded audio". Nothing in the state distinguishes it from a current
  artifact, so a `warn` log at the exclusion point is the only way to enumerate what was
  stranded.
- **There is no self-repair.** Recompute fires on a variant change, so restoring the
  missing provider does not fix stranded posts on its own — it takes another
  byte-mutating run or an operator-forced reprocess.
- **Step 5 is what makes this reachable.** Both current providers select off one API key,
  so a variant cannot change today without a transcriber present. Trim is local compute:
  it sets `variantChanged` with no key configured at all.

Stage → runner lives in **one** place, `capabilitiesOf()` in
`packages/core/services/audio-processing.ts`. Both the deployment's advertised
capabilities and the recompute filter derive from it. Its `Record<ProcessingStage,
boolean>` return type is the guard — **adding a stage fails to compile until it is
handled there**, which is how steps 5 and 6 are forced to declare themselves. An
explicitly requested stage with no runner still settles `skipped`; that reading is
accurate, since nothing was ever produced for it.

### 5. Trim stage — *first local-compute stage*

- New `TrimmerPort` in `packages/core/ports/` (byte-mutating, mirrors `DenoiserPort`).
- Fixed conservative policy: **leading/trailing only**, leave interior gaps, pad rather
  than cutting to the first sample of speech. Threshold/pad are adapter implementation
  detail, not contract.
- **Also re-encode the variant here** (see step 3): this step's decode dependency is what
  makes undoing Voice Isolator's 320kbps inflation cheap.
- Runs **after** denoise, composing into the same `processedBlobCid`; sets
  `processedDurationMs`.
- **Versions:** contract → patch.
- **Done when:** a padded recording trims cleanly with no clipped word onsets.

### 6. Waveform stage

- New `WaveformPort` (derived, local compute) producing peaks normalized 0–100,
  max 1000 — matching the existing embed bounds in `packages/shared/types/audio.ts`.
- Computes over the **processed** variant; writes to `ProcessingState.waveform`.
- Client-supplied `embed.waveform` stays and remains the default for unprocessed posts.
- **Versions:** contract → patch.
- **Done when:** peaks for a denoised post differ from the client's original peaks.

### 7. Hydration variant resolution — *the minor bump*

- The view resolves per field: canonical from the record, variant from `ProcessingState`
  when a processed variant exists. Generalizes the playback-URL swap the view already does.
- Covers `url`, `durationMs`, `waveform`.
- **Versions:** contract → **minor**, `0.3.x` → **0.4.0**. Changelog entry must call out
  that `durationMs`/`waveform` may now describe the processed variant.
- **Done when:** a fully-processed post returns self-consistent url + duration + peaks.

### 8. Durable dispatch — *gates production*

- Replace the inline branch with a real queue trigger + a `/system/process-audio` worker
  (system-auth'd, like the other `/system/*` routes).
- **Build against a thin queue abstraction, not Cloud Tasks directly.** This is the one
  new component with no existing port, and `apps/core-api` may move to Cloudflare —
  Cloud Tasks and Cloudflare Queues both become adapters behind it.
- Recompute (step 4) makes this load-bearing: a recompute triggered by a later PATCH is
  exactly the work that must not run inside a request.
- **Versions:** contract → patch if the system route is documented; none if internal.
- **Done when:** a create with processing requested settles without inline mode.

## Deferred — not in this plan

- **Billing/metering.** Single operator for now; nothing to meter. Revisit before a
  second tenant. See `enrichment-pipeline.md` § Open.
- **Cloudflare migration.** Step 8's queue abstraction is the only concession; no
  migration work implied.
- **Voice-clone / ElevenLabs PVC pairing.** Out of scope for Antiphony — the author is
  handling it in a downstream service authenticating via Bluesky.
