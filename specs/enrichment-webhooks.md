# Enrichment webhooks — push stage results to the tenant BFF

**Status:** proposed 2026-07-19. Extends the durable-dispatch model in
[`enrichment-pipeline.md`](./enrichment-pipeline.md) (step 8) with an **outbound**
notification each time an enrichment stage settles. Companion to
[`service-auth.md`](./service-auth.md) — that is the BFF→core auth; this is the
core→BFF direction.

## The problem

Enrichment runs out of band. A create or `PATCH /api/v1/posts/{postId}` returns as
soon as the job is enqueued (step 8); the denoise / trim / transcribe / waveform work
happens later in the worker, on someone else's clock. So the calling BFF has only
**pull** ways to learn a result landed:

1. **Poll** — `GET` the post's view on a timer and diff its `processing` state.
2. **The reconciliation sweep** (still open after step 8) — a periodic pass that
   re-drives `pending` posts, which incidentally surfaces newly-settled ones.

Both are pull, both are laggy, and polling is wasteful (most GETs find nothing
changed). The BFF has no signal that a *specific* stage finished, so its view of a
post's enrichment is stale between reads.

## The decision

Core POSTs a small, **self-sufficient** webhook to the tenant's configured URL **each
time a stage reaches a terminal state** — `ready`, `failed`, or `skipped`. The payload
names the post, the stage, and the terminal status: enough for the BFF to act without a
follow-up request *to learn what happened*.

Self-sufficiency is the load-bearing property. A webhook that said only *"post X
changed"* would force a `GET` to discover **which** stage and **whether** it succeeded —
barely better than the sweep it is meant to obviate. Carrying `{postId, stage, status}`
means the BFF learns the *what* from the push itself, and issues the hydrated `GET` only
when it actually wants the **artifact** (the transcript text, the signed URL, the peaks)
— the normal REST read, not a "what happened" round-trip. A `waveform: skipped` needs no
GET at all; a `transcribe: ready` invites one, on the BFF's terms.

### The webhook is an accelerator, not a source of truth

The authoritative record of enrichment state is the post's `processing` map in
Firestore, readable via the view. The webhook is a **latency optimization** over that
pull state — never a second source of truth. This is what justifies best-effort
delivery (below): a dropped webhook is a *latency regression* (the BFF learns later, via
its next GET or the sweep), never a correctness bug. The BFF must therefore still be
able to reconcile from the view; the webhook only makes the common case fast.

## Payload

One POST per stage that reaches a terminal state in a pass (not one per pass):

```json
{
  "postId": "3kb2…",
  "originAppId": "voxpop",
  "stage": "transcribe",
  "status": "ready",
  "occurredAt": "2026-07-19T14:03:11.204Z"
}
```

- **`postId`**, **`stage`**, **`status`** — exactly the three the consumer asked for.
  `stage` ∈ `denoise | trim | transcribe | waveform`; `status` ∈ `ready | failed | skipped`
  (the terminal states — `pending` never fires).
- **`originAppId`** — the tenant. A multi-tenant receiver needs it to route; a
  single-tenant one can ignore it. Cheap to include, expensive to retrofit.
- **`occurredAt`** — server settle time, so a receiver can order events and detect a
  stale/replayed delivery.

Deliberately **not** in the payload: the artifact itself (transcript, URL, peaks). Those
vary in size and shape per stage; inlining them would couple the webhook to each stage's
output and bloat the transcribe/waveform cases. The status tells the BFF whether the
artifact is worth fetching; the view is where it fetches it. (If a future consumer wants
the cheap scalars inlined — e.g. `processedDurationMs` on `trim: ready` — that is an
additive change to revisit then, not a v1 commitment.)

## Auth — HMAC over the raw body

Each request carries `X-Antiphony-Signature: sha256=<hex>`, an HMAC-SHA256 of the **raw
request body** keyed by the tenant's webhook secret. The receiver recomputes and
constant-time-compares. This lets the BFF trust the payload **without a callback** — which
is the whole point; a webhook that had to be verified by GETting core would reintroduce
the round-trip we are removing. Include `occurredAt` in the signed body and reject
skewed/old timestamps to blunt replay.

No bearer token: unlike the inbound `/system/*` routes (which core authenticates), here
core is the *client*, and a shared bearer sent outbound would be a static secret on the
wire with no per-message integrity. HMAC binds the secret to the exact bytes.

## Config — per tenant

Keyed on `originAppId`, following the existing `ANTIPHONY_APP_TOKENS` / `ANTIPHONY_APP_DIDS`
shape: each tenant maps to a `{ url, secret }`. A tenant with no webhook configured simply
gets no webhooks (the pull paths still work) — exactly parallel to how a deployment with no
queue config falls back to noop dispatch. Absence is a valid, silent opt-out; **partial**
config (a url with no secret, or vice versa) is a misconfiguration and logs at `error`,
same discipline as the Cloud Tasks vars.

## Delivery — best-effort, decoupled from the pass

Chosen: **best-effort with the sweep as the durability backstop** (not a durable/queued
delivery). Justified by the accelerator framing above — the authoritative state is already
committed to Firestore before any webhook fires, so a drop costs latency, not truth.

Mechanics:

- **Fires after the stage is settled**, never before. `patchProcessingState` writes the
  terminal status first; only then does the notifier POST. Ordering the write first means
  a crash between them loses a *notification*, not a result.
- **Bounded and non-blocking to correctness.** A short timeout (~3s) and a couple of quick
  retries on transient failure. A webhook that times out or errors is **logged and
  swallowed** — it never fails the stage, never throws out of `process()`, and never holds
  the lease. The pass's success is defined by the Firestore writes, not by delivery.
- **At-least-once, and the receiver must dedupe.** Two hazards make a stage's webhook fire
  more than once, and one makes "already saw this" the wrong dedupe:
  - A worker **redelivery** (the queue is at-least-once) re-runs only `pending` stages, so
    an already-settled stage does not re-fire — *except* the narrow window where the pass
    settled the stage, fired (or was mid-POST), then died before releasing the lease;
    redelivery won't re-settle it, so that stage's webhook is more likely **lost** than
    duplicated (→ the backstop).
  - **Recompute** legitimately settles a *derived* stage twice: `transcribe`/`waveform` go
    `ready → pending → ready` when a byte-mutating stage re-runs (step 4). The second
    `ready` is a **new, correct** event describing the recomputed artifact — not a
    duplicate to suppress. So the receiver should treat each event as "latest wins for
    `(postId, stage)`," not "ignore if seen." `occurredAt` is the tiebreaker.

## Fire points — in the service, once

The notifier is invoked from `AudioProcessingService.process()` at the single place each
stage settles, so every dispatcher (inline, Cloud Tasks, future Cloudflare) inherits it —
the hazard-and-signal belongs to `process()`, not to a transport, exactly as the lease
does. It is a new **outbound port** (`ProcessingNotifierPort`, Firebase-free in
`packages/core`), injected like `TranscriberPort` / `ProcessingDispatchPort`; the HTTP +
HMAC adapter lives in `apps/core-api/src/adapters/outbound/`. A deployment with no notifier
wired passes a noop, and nothing changes.

## What this is NOT

- **Not durable delivery.** No queue, no dead-letter, no delivery-state table. Deferred;
  see below.
- **Not a replacement for the reconciliation sweep.** The sweep re-drives posts whose
  *dispatch* died (nothing ran, so nothing settled, so nothing fired). The webhook reports
  stages that *did* run. They cover different failures; both are wanted.
- **Not a public API surface.** It is an outbound integration configured per tenant, not a
  documented `/api/v1/*` route — no OpenAPI change, same as the `/system/*` plumbing.

## Open / deferred

- **Durable delivery (v2).** If best-effort drops prove painful in practice, promote
  delivery onto the existing Cloud Tasks infra (enqueue a delivery task per event, retry
  with backoff, dead-letter after N). The port boundary here is chosen so this is an
  adapter swap, not a service change.
- **Inlining compact results.** Revisit adding cheap scalars (`processedDurationMs`) to the
  `trim: ready` payload if a consumer wants to eliminate even the artifact GET for the
  cheap stages. Additive; not v1.
- **Delivery observability.** A per-tenant success/failure counter (and last-error) would
  make a silently-misconfigured receiver visible without reading logs. Nice-to-have.

## Implementation sketch (for the follow-up PR)

1. **`ProcessingNotifierPort`** in `packages/core/ports/` — `notify(event: StageSettledEvent): Promise<void>`,
   where `StageSettledEvent = { originAppId, postId, stage, status, occurredAt }`. Firebase-free.
2. **Wire into `process()`** — call `notify(...)` immediately after each terminal
   `patchProcessingState`, inside a try/catch that logs and swallows. One call site per
   settle path (the stage loop, the recompute path, the skip path).
3. **HTTP adapter** in `apps/core-api/src/adapters/outbound/webhook/` — resolves the
   tenant's `{url, secret}`, signs the body (HMAC-SHA256), POSTs with a bounded timeout and
   small retry, logs failures. A noop notifier when no tenant is configured.
4. **Config** — per-tenant `{url, secret}` parsed like `ANTIPHONY_APP_TOKENS`; partial
   config is an `error`, none is a silent opt-out. Document in `configuration.md`.
5. **Tests** — mutation-checked: a settled stage fires exactly one event with the right
   `{postId, stage, status}`; a failed POST does not fail the pass or throw; recompute
   fires a second `ready`; a missing tenant config fires nothing. No live HTTP in `npm test`.
6. **Versions** — none. Internal outbound integration; no contract or exported-type change.
