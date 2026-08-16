# Per-stage provider selection and model config

**Status:** ✅ implemented 2026-08-16 (proposed the same day). Widens the
existing provider seam (`specs/enrichment-pipeline.md` § Provider policy) from
one all-or-nothing vendor gate to per-stage selection, and makes model config a
stated convention rather than one ad hoc env read. **No new service, no new
network hop** — the routing seam already exists in `resolveProviders()`; this
changes what it can express, not where it lives.

Landed as described, with one addition noted inline: § 3.2 left the ElevenLabs
denoiser's provenance value open, and it shipped as a fixed
`elevenlabs/audio-isolation` rather than an env knob, because the endpoint
accepts no `model_id` to select between.

**Extended 2026-08-16 with per-tenant selection (§ 6)**, which supersedes half of
§ 5. Read § 6 before § 5's first bullet — the two disagree by design, and § 6 is
the current state.

| Change | Where |
| :--- | :--- |
| Per-stage registry + selection | `apps/core-api/src/lib/provider-registry.ts` (new) |
| `resolveProviders()` rewired | `apps/core-api/src/lib/audio-processing.ts` |
| `model?: string` provenance | `packages/core/ports/audio-denoiser.ts`, set in the ElevenLabs denoiser |
| `denoiseModel` persisted on `ProcessingState` | `packages/shared/types/processing.ts`, written in `AudioProcessingService` — see § 3.2 |
| `resolveModel()` convention + first-use logging | `apps/core-api/src/adapters/outbound/elevenlabs/client.ts` |
| Selection tests | `apps/core-api/src/lib/audio-processing.test.ts` |
| Operator docs | `apps/docs/.../self-hosting/configuration.md` § Providers |
| **Per-tenant provider + model** | `apps/core-api/src/lib/tenant-provider-config.ts` (new) — see § 6 |

## The ask

| | |
|---|---|
| **Add** | A per-stage provider registry behind `resolveProviders()`, selected by four `ANTIPHONY_*` env vars. |
| **Add** | `model?: string` on `DenoiseResult`, closing the provenance gap between denoise and transcribe. |
| **Costs** | One new file, ~80 lines. No contract change to the REST surface, no data migration. |
| **Does not** | Introduce per-tenant or per-request model choice, cross-vendor fallback chains, or a routing service. |

---

## 1. Motivation — two limits, both inside the existing seam

### 1.1 Selection is all-or-nothing on one vendor key

`resolveProviders()` (`apps/core-api/src/lib/audio-processing.ts`) gates the
transcriber *and* the denoiser on `elevenLabsApiKey()` alone:

```ts
if (elevenLabsApiKey()) {
    return { transcriber: elevenLabsTranscriber, denoiser: elevenLabsDenoiser, ...local };
}
```

So a deployment cannot run Scribe for transcription against a different
isolation vendor, or run a real transcriber next to a stub denoiser while
evaluating one of them. Adding a second transcriber adapter today means editing
this branch and inventing a condition to sit beside the key check — which is
exactly the "separate enable flag to keep in sync" the current comment
(rightly) avoids.

Trim and waveform have the same shape one level down: `ffmpegAvailable()`
governs both together. That coupling is *correct* — one binary, two stages —
but it is currently expressed as a shared `if` rather than as two entries that
happen to share a probe, so it does not generalize.

### 1.2 Model config exists for exactly one stage, by accident

Smaller than it looks. The transcriber already reads a model per call and
records it as provenance:

```ts
const DEFAULT_MODEL = 'scribe_v2';
const model = process.env.ELEVENLABS_STT_MODEL?.trim() || DEFAULT_MODEL;
```

and `AudioProcessingService` writes `result.model` into the saved transcript
(`packages/core/services/audio-processing.ts:476`). That is the right design and
the right layer — the model name never crosses the port, satisfying
`enrichment-pipeline.md` § Provider policy. Three things are missing around it:

- **No denoise provenance.** `DenoiseResult` carries `{ bytes, mimeType }` and
  nothing else, so which isolation model produced a given `processedBlobCid` is
  unrecorded. After a model switch there is no way to tell which variants
  predate it. Transcribe can answer this; denoise cannot.
- **The convention is undocumented**, so the second adapter to need a model knob
  will invent a different variable name.
- **A typo resolves silently.** `ELEVENLABS_STT_MODEL=scibe_v2` is a valid
  string, so the deployment looks configured, and every post fails at the
  provider with a 400 — after uploading the audio.

Note the denoise adapter sends no `model_id` at all today, and this proposal
does not claim the `/audio-isolation` endpoint accepts one. § 3.2 records the
model the adapter *believes* it used; wiring a real knob is only worthwhile if
and when the endpoint exposes one.

---

## 2. Per-stage registry

### 2.1 Shape

New file `apps/core-api/src/lib/provider-registry.ts`. One entry per concrete
implementation, each carrying its own availability probe.

> **Note:** the `port: T` field shown below became `create(model?): T` when
> per-tenant selection landed — see § 6.2. The rest of this section is
> unchanged and still describes the shipped behavior.

```ts
interface ProviderEntry<T> {
    /** Selector value for the stage's env var. */
    readonly name: string;
    /** True when this deployment can actually run it right now. */
    available(): boolean;
    /**
     * Never chosen by the default scan — only by an exact env match.
     * See § 2.3: a stub reached by fallback is worse than no stage at all.
     */
    readonly explicitOnly?: true;
    readonly port: T;
}

const TRANSCRIBERS: ProviderEntry<TranscriberPort>[] = [
    { name: 'elevenlabs', available: () => !!elevenLabsApiKey(), port: elevenLabsTranscriber },
    { name: 'stub', available: () => true, explicitOnly: true, port: stubTranscriber },
];
```

…and likewise `DENOISERS`, `TRIMMERS`, `WAVEFORMS`. The two ffmpeg stages stay
coupled by *sharing the probe function*, not by sharing a branch:

```ts
const TRIMMERS: ProviderEntry<TrimmerPort>[] = [
    { name: 'ffmpeg', available: ffmpegAvailable, port: ffmpegTrimmer },
    { name: 'stub', available: () => true, explicitOnly: true, port: stubTrimmer },
];
```

### 2.2 Selection

```ts
function select<T>(entries: ProviderEntry<T>[], envVar: string): T | undefined {
    const requested = process.env[envVar]?.trim().toLowerCase();
    if (!requested) return entries.find((e) => !e.explicitOnly && e.available())?.port;

    const entry = entries.find((e) => e.name === requested);
    if (!entry) {
        logger.error({ envVar, requested, known: entries.map((e) => e.name) },
            '[audio-processing] unknown provider requested — stage disabled');
        return undefined;
    }
    if (!entry.available()) {
        logger.error({ envVar, requested },
            '[audio-processing] provider requested but not configured — stage disabled');
        return undefined;
    }
    return entry.port;
}

export function resolveProviders(): ProcessingProviders {
    // Unchanged, and deliberately still first: a dev/test env with a real key
    // in the shell must not bill a live provider.
    if (process.env.ANTIPHONY_PROCESSING_STUB === 'true') {
        return { transcriber: stubTranscriber, denoiser: stubDenoiser,
                 trimmer: stubTrimmer, waveform: stubWaveform };
    }
    return {
        transcriber: select(TRANSCRIBERS, 'ANTIPHONY_TRANSCRIBER'),
        denoiser: select(DENOISERS, 'ANTIPHONY_DENOISER'),
        trimmer: select(TRIMMERS, 'ANTIPHONY_TRIMMER'),
        waveform: select(WAVEFORMS, 'ANTIPHONY_WAVEFORM'),
    };
}
```

Assigning `undefined` to the optional fields of `ProcessingProviders` is safe —
`capabilitiesOf` tests `!!providers.transcriber`, and the root tsconfig sets
`strict` without `exactOptionalPropertyTypes`, so an explicit `undefined` and an
omitted key are interchangeable here. That is what lets the spread-`...local`
dance go away.

Everything downstream is untouched: `processingCapabilities()` still delegates
to `capabilitiesOf(resolveProviders())`, so there is still exactly one mapping
from wired providers to runnable stages, and `resolveInitialProcessing()` still
resolves an uncapable stage to `skipped`.

### 2.3 Two decisions worth stating

**Stubs are never reached by fallback.** Without `explicitOnly`, a production
deployment that lost its API key would slide from `transcribe: 'skipped'` — the
truthful state, which the pipeline already handles — to stub transcripts saved
as real records against real posts. Honest absence beats plausible garbage. The
existing `ANTIPHONY_PROCESSING_STUB` flag remains the way to get stubs
wholesale; the per-stage names exist for mixed local runs.

**An unavailable explicit request is a misconfiguration, not an opt-out.** This
is the same call already made for dispatch in this file: partial Cloud Tasks
config logs an error rather than degrading silently to noop, because "a
deployment that set some of the queue vars believes it has durable dispatch and
has none." `ANTIPHONY_TRANSCRIBER=elevenlabs` with no key is the identical
mistake. It logs and the stage goes unavailable; it does not fall through to the
next entry, because falling through would mean the operator's explicit choice
was overruled without a word.

---

## 3. Model config

### 3.1 Convention (no mechanism)

Model selection stays **inside the adapter**, read per call off env, defaulted
to a constant in the adapter. This is what the transcriber already does; the
change is to write it down so the next adapter matches it:

> `<VENDOR>_<CAPABILITY>_MODEL`, resolved per call via
> `process.env.X?.trim() || DEFAULT_MODEL`, never at module load, and surfaced
> on the port's result type as provenance — never on its input type.

The last clause is the load-bearing one. A model name on `TranscriptionInput`
would let core name a vendor model and would break the provider policy. On
`TranscriptionResult` it is a report of what happened, which is portable: a
Whisper adapter reports `whisper-large-v3` and nothing upstream cares.

Deliberately **not** proposed: validating the env value against a list of known
model ids. It would catch the typo in § 1.2, but it means a code change to adopt
a model the vendor shipped that morning — a bad trade against a fast-moving
vendor. Log the resolved model on first use instead, so it appears in the
deployment's startup trail and a typo is one grep away.

### 3.2 Close the denoise provenance gap

```ts
export interface DenoiseResult {
    bytes: Uint8Array;
    mimeType: string;
    /** Provider/model identifier, when the provider reports or fixes one. */
    model?: string;
}
```

Optional, so the stub and the current ElevenLabs adapter satisfy it unchanged.

`TrimResult` and `WaveformResult` get nothing — both are local compute with no
model.

#### Persistence — settled 2026-08-16

This proposal originally left the consumer side open, on the reasoning that a
denoised variant has no record of its own to carry provenance (it is a blob CID
on `ProcessingState`) and the choice between a state field and logs-only should
wait for a second denoiser. **Settled early, as a state field**, because
per-stage selection (§ 2) is itself what makes a post able to meet two
denoisers — the condition the decision was waiting for arrived with the same
change that created it.

- **`denoiseModel` on `ProcessingStateSchema`**, not `processedModel`. It
  describes one link of the byte-mutating chain, not the composed artifact:
  trim contributes to the same variant and has no model, and a later external
  link would want its own field rather than to overwrite this one.
- **Internal.** `toProcessingView` projects stages only, so this never reaches a
  client and the API contract is unchanged — no `CHANGELOG.md` entry, since that
  file tracks the contract rather than storage.
- **Written unconditionally on every successful denoise**, falling back to
  `'unnamed'` when the provider names none. The port field is optional but the
  state field cannot be: `patchProcessingState` skips `undefined` keys, so a
  silent write would leave the *previous* denoiser's name describing new bytes —
  worse than absence, because it reads as a positive claim.
- **Never cleared.** It moves with `processedBlobCid`, which is only ever set,
  never reset. A denoise that FAILS leaves both alone, which is correct: the
  variant still holds the previous denoiser's output.
- `stubDenoiser` now names itself `stub`, matching `stubTranscriber`.

No migration. The field is optional and absent on every existing post, which
reads correctly as "no denoise has run under a provenance-recording build."

---

## 4. Tests

`apps/core-api/src/lib/audio-processing.test.ts` already saves and restores a
`PROVIDER_ENV` list around each case; extend it with the four new vars. The
cases worth adding:

- each stage resolves independently (real transcriber + stub denoiser),
- `ANTIPHONY_PROCESSING_STUB=true` still overrides all four,
- an explicit name with no key logs and yields `capabilities.transcribe === false`,
- an unknown name logs and disables rather than falling back,
- no env set reproduces today's behavior exactly (key ⇒ both external stages;
  ffmpeg ⇒ both local stages).

The last is the regression gate: this change must be a no-op for every existing
deployment, none of which set the new vars.

---

## 5. What this does not do

Named so the next person does not assume otherwise:

- ~~**No per-tenant or per-request model choice.**~~ **Superseded 2026-08-16 for
  the per-tenant half** — see § 6. Per-*request* choice remains out of scope,
  and now deliberately rather than incidentally: it would let a tenant name an
  arbitrary model on the deployment's key, which is a cost and abuse surface
  that ops config does not have.
- **No fallback chains.** One entry is selected; a provider outage fails the
  stage, which `AudioProcessingService` already settles per stage without
  affecting siblings.
- **No routing service.** A separate deploy unit is justified when several
  services make AI calls and need shared key custody, spend accounting, or rate
  limiting across them. Today `core-api` is the only caller, so a router would
  be a second service with one client and one more failure mode.

---

## 6. Per-tenant selection — added 2026-08-16

§ 5 ruled this out on the grounds that "the seam has to take a parameter, and
every call site threads it — and nothing asks for it yet." The first half was
right and is exactly what happened; the second stopped being true.

The cost estimate was also too high, because it assumed the model would have to
cross the port. It does not — see § 6.2.

### 6.1 Config surface

Per-tenant registries in the established `appId:value` shape
(`ANTIPHONY_APP_TOKENS`, `ANTIPHONY_APP_DIDS`, `ANTIPHONY_APP_WEBHOOK_URLS`),
parsed in `apps/core-api/src/lib/tenant-provider-config.ts`:

| Variable | Maps |
| :--- | :--- |
| `ANTIPHONY_APP_TRANSCRIBERS` | `originAppId → provider name` |
| `ANTIPHONY_APP_DENOISERS` | same |
| `ANTIPHONY_APP_TRIMMERS` | same |
| `ANTIPHONY_APP_WAVEFORMS` | same |
| `ANTIPHONY_APP_STT_MODELS` | `originAppId → transcription model id` |

Three layers, narrowest first: **tenant pin → deployment default → first
available**. A tenant with no entry resolves exactly as before, which is the
regression gate.

**Ops config, deliberately — not a request field.** The alternative shape was a
`model` on the `processing` opt-in. Rejected: it is a contract change, and it
would let a tenant invoke an arbitrary expensive model on the deployment's key.
Ops config has neither problem, and a tenant's model is a commercial decision
someone makes once, not per post.

### 6.2 The model never crosses the port

The obvious implementation — `model` on `TranscriptionInput` — would let
`@antiphony/core` name a vendor model, breaking § Provider policy of
`enrichment-pipeline.md`. Avoided by making the adapter a **factory**:

```ts
export function elevenLabsTranscriber(modelOverride?: string): TranscriberPort
```

The model is chosen at WIRING time and closed over, so what varies per tenant is
composition (`resolveProviders(originAppId)`), not the contract. `TranscriberPort`
is untouched. This is why the change came in smaller than § 5 predicted.

Registry entries therefore hold `create(model?)` rather than a fixed instance,
plus `acceptsModel` — an entry without it reports a tenant model rather than
accepting one it would silently ignore. Only the ElevenLabs transcriber sets it
today; `/audio-isolation` takes no `model_id`, and trim/waveform are local
compute.

### 6.3 Capabilities became tenant-scoped

`processingCapabilities(originAppId)` and `resolveInitialProcessing(originAppId,
request)` are the consequence, not an extra: a tenant pinned to a provider this
deployment cannot run has that stage unavailable while its neighbours still do.
Answering deployment-wide would advertise a stage the pinned tenant can never
get and store `pending` for work nothing will perform.

Threaded at four call sites, each of which already had the tenant in hand:
both `posts.ts` routes, `dispatchProcessing`, and the `system-process-audio`
worker. The worker resolves for the **job's** tenant, not the caller's — it is
system-auth'd and the caller is the queue, so wiring the caller's tenancy would
run one tenant's post through another's provider.

### 6.4 Failure behavior, unchanged in kind

A bad tenant pin behaves exactly as a bad deployment default: logged at `error`,
stage honestly unavailable, **no fallback** — including no fallback to the
deployment default, which would silently overrule the pin. Scoped to the tenant:
one bad entry is not an outage for its neighbours, and a malformed pair drops
with a log without taking out the rest of the variable.

### 6.5 Still out of scope

Per-*request* model choice (§ 5, now with a reason rather than a deferral) and
cross-vendor fallback chains.
