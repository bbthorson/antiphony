# Public documentation audit — `docs.antiphony.dev`

**Date:** 2026-07-25 · **Scope:** the 12 pages under `apps/docs/src/content/docs/`
(the public Starlight site), audited against the code at `e69bf87`.

> **Status: resolved.** Every finding below was fixed in the commit that follows
> this one. `apps/reference` was migrated to a server-side dev BFF (1.4), and the
> full record → upload → post → hydrate loop was re-verified through it against
> the emulators. One thing the docs now *state* rather than fix: `did:web`
> pinning has no offline path (1.2), so the quick start requires a real domain.
> Closing that gap needs a product decision, not a docs edit — see the note at
> the end of [Suggested order](#suggested-order).

**Headline:** the mechanics are clean — the site builds, every internal link and
anchor resolves, every GitHub deep link points at a real path, and the lexicon
reference matches the JSON field for field. The problem is **content drift from a
single breaking change**: the `0.2.0` migration to service-token-only auth
(`CHANGELOG.md`, "BREAKING — auth is service-token-only") landed in the code and
the CHANGELOG but never propagated to the docs site. Six of the twelve pages still
describe the removed Firebase end-user token path, including the only page that
tells a reader how to make their first API call.

Verified empirically, not inferred — see [Method](#method).

---

## Severity 1 — the documented getting-started path does not work

### 1.1 Quick start §4 returns `401` on every call

`self-hosting/quick-start.md:57-76` instructs the reader to mint an emulator ID
token from the Firebase Auth emulator UI and send it as the bearer. Every data
route rejects it. Replayed against the real app factory:

```
POST /api/v1/audio/upload   → 401 {"success":false,"error":{"message":"Invalid service token"},…}
GET  /api/v1/posts/{postId} → 401 {"success":false,"error":{"message":"Invalid service token"},…}
```

`middleware/auth.ts` has no Firebase branch at all — `serviceTokenGate` 401s
unless the bearer matches an `ANTIPHONY_APP_TOKENS` entry. This is the only page
that shows a reader how to call the API, and none of its three example calls can
succeed as written.

**Fix:** set `ANTIPHONY_APP_TOKENS=local:<32+ char token>` in the step-3 env block
and use that token as the bearer, plus `X-Antiphony-Acting-Actor: <any-user-id>`
on the write and viewer-scoped calls. Drop the Firebase Auth emulator UI step.

### 1.2 `ANTIPHONY_APP_DIDS` is required and undocumented

Not mentioned on any public page, yet without it every post read and write fails:

```
boot gate: passed with no ANTIPHONY_APP_DIDS set
getAppDid("local") THREW -> [app-did] no validated app DID for tenant "local"
```

The trap is that the boot gate *passes* with an empty pin set (`app-did.ts:212`,
"An empty pin set is valid"), so the service starts cleanly and then throws on the
first `buildPostUri` call (`packages/core/services/audio-posts.ts:404,418`). A
self-hoster following Configuration end to end gets a healthy-looking process that
500s on its first real request.

This also has a documented consequence with no documented cause:
`lexicons/overview.md:125-131` states a post's `at://` authority "is always the
tenant's own `did:web`" — true, and it comes from this variable, which the reader
is never told to set. Worse for local dev: `validateAppDid` performs a live
`did:web` resolution requiring an `#atproto_pds` service endpoint, so the pin
cannot be satisfied offline. The quick start needs to say how to get past that.

**Fix:** document `ANTIPHONY_APP_DIDS` (and `ANTIPHONY_PDS_HOST`, which gates the
host-match half of the custody check) in Configuration under a new "Tenant
identity" section, and give the quick start a working local recipe.

### 1.3 `ANTIPHONY_ORIGIN_APP_ID` is dead config, documented as live

Documented as meaningful in three places — `configuration.md:14` (the fallback
tenancy key), `quick-start.md:44,55` (set in the run command and explained), and
`build-your-own/reference-app.md:92`. It is read nowhere in production code; only
tests set it. `lib/origin-app.ts:10` is explicit: *"There is no deploy-level
default fallback."* `CHANGELOG.md:208` records the removal.

The stale code comment at `apps/core-api/src/adapters/inbound/rest/posts.ts:31-34`
("else deploy config (`ANTIPHONY_ORIGIN_APP_ID`, default `antiphony`)") is likely
where the docs inherited it — worth fixing at the same time.

### 1.4 `apps/reference` is stale, and two pages depend on it

`apps/reference/src/lib/firebase.ts` still signs in anonymously and passes the
Firebase ID token as the bearer (`lib/api.ts:37`). Against current `core-api` that
is a guaranteed `401` — the same failure as 1.1.

This is a code defect, not a docs one, but it invalidates
`build-your-own/reference-app.md` wholesale and undercuts
`build-your-own/overview.md:25-29`, which sells `apps/reference` as the thing to
learn from and as "the contract's acceptance harness". An acceptance harness that
cannot authenticate is not signalling anything.

---

## Severity 2 — statements that are now false

| Where | Says | Actually |
| :--- | :--- | :--- |
| `introduction/architecture.md:38` | Routes mount `posts`, `actors`, `audio`, "and the legacy `users`/`atproto`/`resolve` surface" | `app.ts:118-132` mounts `posts` and `audio` only (plus `/api/v1/system/*`). `actors`, `users`, `atproto`, `resolve` were all removed — `CHANGELOG.md` "Actors surface" / "Users surface". Contradicts `api/overview.md:21`, which is correct. |
| `introduction/architecture.md:37` | Auth resolves "a service-authenticated app … or, for the demo path, a verified Firebase end-user token" | No Firebase path exists. |
| `introduction/architecture.md:53` | "`ANTIPHONY_ORIGIN_APP_ID` remains only as the fallback for the Firebase end-user demo path" | Both the variable and the path are gone. |
| `build-your-own/reference-app.md:66` | `view.author → profile basic` | `AudioPostViewSchema` (`packages/shared/types/audio.ts:311-313`) carries opaque `authorId` + optional `authorDid`. `author` was removed — `CHANGELOG.md` "BREAKING — post-view author shape". Contradicts `introduction/overview.md:33`, which is correct. |
| `build-your-own/overview.md:34` | "the local/demo path (what `apps/reference` uses) is an anonymous Firebase token" | Not accepted. |
| `explanation/connectors.md:51` | Consumer-API auth is "a service credential … (or, for local demos, an anonymous end-user token) … Public projections accept no token" | Both halves wrong. `api/overview.md:51` states the rule correctly: no token → `401` on every data route; "public" means no *viewer*, not no *tenant*. |
| `explanation/connectors.md:62` | Egress connectors use "often an anonymous viewer token" | Same. |
| `self-hosting/configuration.md:14` | `ANTIPHONY_ORIGIN_APP_ID` is "the **fallback** tenancy key for end-user (Firebase-token) callers" | Dead — see 1.3. |

---

## Severity 3 — real behavior the reader will hit and can't find

1. **Upload limits are wrong by 4×.** `lexicons/overview.md:54` cites the
   lexicon's `audio/*` / 100 MB — accurate *as a lexicon fact*, and the only
   number on the site. The endpoint enforces **25 MB**
   (`audio-upload.ts:37`) and a **seven-type MIME allowlist**
   (`audio/m4a`, `x-m4a`, `mp4`, `mpeg`, `webm`, `ogg`, `wav` — `audio-upload.ts:27`).
   A reader sizing a client off the docs ships something that 400s. The gap
   belongs on `api/overview.md` or `build-your-own/overview.md`; the lexicon page
   should note that the API cap is tighter than the record's.

2. **Rate limits are undocumented.** Every route carries one
   (`middleware/rate-limit.ts:39-54`): writes **10 per 15 min**, reads **60/min**,
   uploads **20/hour**, `429` on breach. The write limit in particular is tight
   enough that an integrator will hit it during normal development and have
   nothing to consult. Nothing on the site mentions `429` at all.

3. **`Idempotency-Key` is unmentioned in prose.** `POST /api/v1/posts` supports it
   (`lib/idempotency.ts`, `posts.ts:265`) and it's in the CORS allowlist
   (`app.ts:89`). It reaches the generated reference via the route description, but
   the hand-written pages — which is where a reader learns the envelope and header
   conventions — never say so. It belongs in `api/overview.md` beside the envelope
   section.

4. **Missing from Configuration:** `ANTIPHONY_APP_DIDS` and `ANTIPHONY_PDS_HOST`
   (both in production `apphosting.yaml`, lines 82 and 68) and `TRUSTED_PROXY_HOPS`
   (`lib/client-ip.ts:28` — it governs client-IP trust behind a proxy, so a wrong
   value mis-attributes rate limiting).

---

## Severity 4 — minor

- `self-hosting/quick-start.md:52` — the documented smoke-test output is
  `{"ok":true}`; the route returns `{"ok":true,"sha":"dev","deployedAt":null}`
  (`app.ts:108-114`).
- `index.mdx:53` — "It gives you identity, audio posts, replies, and transcription"
  (and the hero tagline's "identity"). Every other page says the opposite:
  `introduction/overview.md:6` — the core "deliberately does **not** own end-user
  accounts, profiles, or sign-in." The splash page is the first thing a reader
  sees and it mis-sells the boundary. `explanation/connectors.md:20`'s hub diagram
  ("· DIDs") has a milder version of the same problem.
- `explanation/connectors.md:50-52` — the planes table gives the ingestion path
  shape as `system/*` against the consumer's `/api/v1/*`, implying a separate root.
  It is `/api/v1/system/*` (`app.ts:126-132`).
- `api/overview.md:16-20` — "the canonical resources" omits
  `PATCH /api/v1/posts/{postId}` (post-hoc enrichment) and the `?rootAuthor=`
  slice, both of which other pages rely on. `explanation/connectors.md:26` and
  `api-design-principles.md:12` both build their central "no `GET /inbox`" argument
  on `rootAuthor`, so the API overview is the one page that should name it.
- `lexicons/overview.md:126` — "(app-as-repo-owner — see the
  [authority model](/introduction/architecture/))" resolves to a page with no
  authority-model content. The real treatment is
  `specs/atproto-authority-model.md`; link there, as neighbouring pages already do
  for `specs/service-auth.md`.

---

## What's in good shape

Worth stating, because it's most of the site:

- **Mechanics are clean.** 13 pages build with no errors; **0** broken internal
  links or heading anchors across every `](/…)` reference; all 6 GitHub deep links
  resolve to real paths.
- **The lexicon reference is accurate.** Field-by-field against the five JSON
  files: required sets, `maxGraphemes: 300` / `maxLength: 3000` on `text`, the
  `waveform` 0–100 normalization, `key: literal:self` on `actor.profile`, the
  record-vs-view split, and the `#timedTranscript` shape all match. The
  crown-jewel page earns the billing.
- **The enrichment-webhook docs are correct** — payload fields, the
  `sha256=<hex>` HMAC over the raw body, and the latest-wins guidance all match
  `adapters/outbound/webhook/notifier.ts`. The newest docs are the healthiest,
  which is the tell: drift is a propagation problem, not a care problem.
- **Verified accurate elsewhere:** the response envelope and `X-Request-ID`
  contract; reply gating including `viewer.canReply` and both
  `replyDisabledReason` values; the audio proxy's anonymous, capability-based
  exception; and `api/overview.md`'s auth section, which is the one page that
  describes the current model correctly.

---

## Suggested order

1. Fix the auth story across all six pages (1.1, 1.4, §2). One breaking change,
   one sweep — this is the whole of Severity 1–2 apart from the route list.
2. Document `ANTIPHONY_APP_DIDS` / `ANTIPHONY_PDS_HOST` and delete
   `ANTIPHONY_ORIGIN_APP_ID` (1.2, 1.3).
3. Update `apps/reference` to service-token auth, then re-verify
   `reference-app.md` against it (1.4).
4. Add limits, rate limits, and `Idempotency-Key` (§3).
5. Sweep Severity 4.

A docs-drift guard would keep this from recurring: the auth change was already
recorded in the CHANGELOG under a "Docs" heading that listed the OpenAPI narrative
and two specs — the docs *site* simply wasn't on the checklist.

### The one gap docs can't close

Finding 1.2 is now **documented** rather than **solved**. `did:web` resolution is
HTTPS-only, so there is no way to satisfy `ANTIPHONY_APP_DIDS` on a laptop, and
the quick start therefore asks for a domain the reader controls. That is an honest
description of the system, but it is a real barrier to "clone it and run it."

Closing it is a product decision with a security dimension, so it wasn't taken
unilaterally. Three options, roughly in order of preference:

1. **A pre-validated local pin.** Accept a `did:web` whose host is loopback and
   skip the custody fetch *only* then, gated on `ANTIPHONY_USE_EMULATOR`. Narrow
   and hard to misuse in production, since the DID itself must be a localhost one.
2. **An injectable resolver.** `validateAllPins` already takes a `fetchImpl` for
   tests; a documented "offline pin file" would reuse that seam.
3. **A blanket skip flag.** Simplest, and the worst — a single env var that
   disables a custody proof is exactly the kind of thing that ends up set in
   production.

Until one lands, the caution block in the quick start is the honest answer.

## Method

Claims were checked against the source, and the two failure modes in Severity 1
were reproduced rather than inferred: the `401`s in 1.1 by driving the real `app()`
factory with a Firebase-shaped token under the env from `quick-start.md` §3, and
the throw in 1.2 by running `validateAllPins()` + `getAppDid()` exactly as
`src/index.ts` boots them. Links and anchors were checked by extracting every
heading and every `](/…)` reference across all 12 pages and resolving them
pairwise. The site was built with `npm run build -w @antiphony/docs`.
