# The `mp3` rendition stage — adopting Vox Pop's transcoder

**Status:** Proposed 2026-08-16, not implemented. Adds a fifth B5 processing
stage that produces an mp3 encoding of a post's final audio variant, so
consumers that cannot decode opus stop needing a request-time transcoder.
Originates from `specs/future/cloudflare-migration.md` § 9 in `bbthorson/vox-pop`,
which defers the decision here. **It diverges from the Vox Pop-side proposal in
one place** — the serving mechanism, see § "The serving side".

## Why this exists

Vox Pop runs a small Cloud Run service, `apps/audio-rendition`, that transcodes
webm/opus → mp3 on demand. It exists for one reason: **Twilio's `<Play>` cannot
decode opus.** It does not reject it either — it fetches the URL and plays about
a minute of static, invisibly, which is why the check that guards it is written
to fail closed.

That service is the **only remaining reason the Vox Pop repo needs Google
Cloud** after its Cloudflare migration. No Workers runtime can spawn a
subprocess, so ffmpeg cannot follow the rest of the stack to the edge. Its
migration spec § 9 already names the fix and defers it here:

> The strategically right long-term home is Antiphony, at ingest. It already
> carries ffmpeg and it owns the blob store, so producing an mp3 rendition when
> the blob lands removes the request-time transcoder from this repo entirely.

This spec is that adoption. Confirmed as the direction 2026-08-15.

## What we are plugging into — it is most of the way there already

Antiphony's B5 pipeline (`specs/enrichment-pipeline.md`) already has everything
this needs except a place to put the output:

| Piece | Where |
| :-- | :-- |
| ffmpeg adapters | `apps/core-api/src/adapters/outbound/ffmpeg/{trimmer,waveform}.ts` |
| Stage classification | `packages/shared/types/processing.ts` — `BYTE_MUTATING_STAGES`, `DERIVED_STAGES` |
| Provider → capability mapping | `capabilitiesOf()` in `packages/core/services/audio-processing.ts` |
| Per-stage state machine | `pending` → `ready`/`failed`/`skipped` |
| Recompute on invalidation | byte-mutating completes → derived marked `pending` again |
| Concurrency safety | `PROCESSING_LEASE_MS`, transactional lease claim |
| **Per-post opt-in after the fact** | **`PATCH /api/v1/posts/{postId}`, `processing` field** |

That last row is worth dwelling on: **the "PATCH to request encoding" idea is
already built.** It is the existing opt-in mechanism, and adding a stage to it
is a schema change, not a new endpoint.

## The central design decision: `mp3` is a third kind of stage

Today stages are classified on two axes, and **mp3 fits neither**.

### It must NOT be byte-mutating

`BYTE_MUTATING_STAGES` (`denoise`, `trim`) compose into a single processed
variant addressed by `processedBlobCid`, and **the read-time view swaps playback
to that variant**. If `mp3` joined them, every listener — web, embed, mobile —
would start receiving mp3 instead of the opus/processed variant.

That is a quality regression for every consumer, imposed to satisfy one
consumer's codec limitation. Opus at a given bitrate beats mp3 comfortably, and
the original is what the CID commits to.

> **This is the trap to guard against in review.** `mp3` produces bytes, so
> "byte-mutating" is the intuitive bucket, and the damage would not be visible
> in any test that only asserts a stage reached `ready`.

### It is derived in behaviour, but not in shape

`DERIVED_STAGES` (`transcribe`, `waveform`) are "pure analysis over the final
variant". The mp3 shares their essential property — **it is a function of the
final variant, so recomputation is always the correct response to its input
changing.** Trim runs after an mp3 exists, the mp3 now describes superseded
audio, and it must be regenerated. That is exactly the invalidation the derived
set already gets for free.

But derived stages return *inline values* — `WaveformResult.peaks`,
transcript text — that live directly on `ProcessingState`. An mp3 is a blob:
it needs storing, content-addressing, and signing.

### So: add a `RENDITION_STAGES` axis

A stage that is **derived in invalidation semantics** but **produces a stored
blob rather than an inline value**.

```ts
export const PROCESSING_STAGES = ['denoise', 'trim', 'transcribe', 'waveform', 'mp3'] as const;

export const BYTE_MUTATING_STAGES = ['denoise', 'trim'] as const;
export const DERIVED_STAGES       = ['transcribe', 'waveform'] as const;

/**
 * Derived like the above — a function of the final variant, recomputed when a
 * byte-mutating stage changes it — but the output is a stored blob, not an
 * inline value. It is an ALTERNATIVE ENCODING for consumers that cannot decode
 * the variant, never a replacement for it.
 */
export const RENDITION_STAGES = ['mp3'] as const;
```

The recompute filter should key off `DERIVED_STAGES ∪ RENDITION_STAGES`. The
read-view's playback resolution must key off **byte-mutating only** — that
separation is the whole point.

### `ProcessingState` additions

Mirroring the existing `processed*` fields:

```ts
/** CID of the mp3 rendition of the FINAL variant. Never the playback default. */
mp3BlobCid: z.string().optional(),
/** Always 'audio/mpeg'. Stored rather than assumed, per the trimmer's lesson. */
mp3MimeType: z.string().optional(),
```

Store the mime type explicitly. `TrimResult` already documents why: blobs are
served with their stored content type, so a mislabelled blob breaks playback
with no exception, no failed stage, and nothing in the logs.

## The serving side: the header will not work

The proposal was an optional header on the blob `GET`. **`Accept: audio/mpeg` is
the correct HTTP idiom and it cannot serve the actual consumer.**

Twilio fetches `<Play>` URLs as a bare `GET`. It sets no custom headers and its
`Accept` is not under our control. The single use case driving this work is
therefore the one case content negotiation by header cannot reach.

Three options, in preference order:

**1. No negotiation — the rendition is its own addressable blob (recommended).**
The mp3 gets a CID like any other blob. The post view surfaces it. Vox Pop's BFF
reads `mp3BlobCid`, signs a URL for it, and hands Twilio a plain URL. This needs
**no new serving path, no negotiation, and no change to the blob route at all** —
it reuses content addressing exactly as `processedBlobCid` does.

**2. A query parameter baked into the signed URL** (`?format=mp3`). Works where a
header cannot, because the signature covers the query string and Twilio simply
fetches what it is given. Worth adding only if a caller genuinely wants one URL
that resolves per-format; it is sugar over (1).

**3. `Accept` header negotiation.** Correct for programmatic callers, useless for
Twilio. Additive later if wanted; it should not be the mechanism this depends on.

Recommendation: ship (1). It is less code than the proposal and removes the
transcoder from the serving path completely, which is the actual goal.

## Eager or lazy?

Both mechanisms already exist and they answer different questions:

- **Eager** — `CreateAudioPostRequest.processing.mp3 = true`. Every post that
  might be phoned gets an mp3 at ingest. This is § 9's "at ingest" and gives the
  best call latency, at the cost of transcoding posts nobody ever dials.
- **Lazy** — `PATCH /api/v1/posts/{postId}` on first need. Costs nothing for
  posts never called, but the first caller waits or gets degraded audio, which
  is precisely the failure Vox Pop just spent a fix on.

Recommendation: **eager for Vox Pop**, via the create-time opt-in. Its volume is
tiny (13 blobs total) and the whole point is removing latency from the call path.
Keep the stage off by default platform-wide, consistent with every other stage.

## Sequencing

**Phase 1 — the stage, in Antiphony.** Add `mp3` to `PROCESSING_STAGES` and
`RENDITION_STAGES`; add a `TranscoderPort` alongside `TrimmerPort`; implement
`adapters/outbound/ffmpeg/transcoder.ts`; extend `capabilitiesOf()`; add the two
`ProcessingState` fields; surface `mp3BlobCid` on the post view. Ships dark —
nothing requests it.

**Phase 2 — backfill.** Existing blobs have no mp3. `PATCH` per post covers the
long tail; a sweep covers the rest. Vox Pop has 13 blobs, so this is minutes.

**Phase 3 — Vox Pop consumes it.** The BFF prefers `mp3BlobCid` when present;
telephony's `resolvePromptAudio` loses its probe-and-fallback entirely, because
an mp3 CID either exists or it does not — no HEAD probe, no 2s budget, no
cold-start race, no spoken-title degradation. Delete `isTwilioPlayable`'s
rendition branch.

**Phase 4 — retire the transcoder.** Unset `AUDIO_RENDITION_FUNCTION_URL` and
`TELEPHONY_AUDIO_FUNCTION_URL`, delete `apps/audio-rendition`,
`Dockerfile.audio-rendition`, and `deploy-audio-rendition.yml`.

**What Phase 4 buys, beyond deleting a service:** it is the last Google Cloud
dependency in the Vox Pop repo. Its migration spec § 13 currently says GitHub
Actions "never reaches zero" *because* of this service. After this, it can.

## Open questions

1. **Blob-signing ownership.** Vox Pop's migration spec § 4 (Phase E) says settle
   this before cross-repo audio work — see `specs/archive/stream4-forward-plan.md`
   in that repo. A change to how Antiphony signs blob URLs is a change to Vox
   Pop's audio path, and this spec adds a second signed object per post.
2. **R2.** Vox Pop's § 8 moves blobs GCS → R2. If Antiphony's blobs move too,
   the mp3 rendition should land in the destination rather than being migrated
   twice — sequence with that, not before it.
3. **Bitrate and channels.** The current Vox Pop transcoder emits 64 kbps mono
   22.05 kHz, which is generous for a phone line (µ-law is 64 kbps at 8 kHz) and
   fine for a browser download. Keep it adapter policy, not contract — the same
   reasoning that keeps the trimmer's threshold out of `TrimmerPort`.
4. **Does the creator-download path want this too?** Vox Pop's
   `GET /replies/{id}/download` currently uses the same transcoder to serve a
   named mp3. If it reads `mp3BlobCid` instead, the `filename` handling stays in
   Vox Pop and Antiphony only supplies bytes — which seems right, but it means
   the rendition serves two consumers with different needs.
