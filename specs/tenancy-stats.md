# Tenancy stats — `GET /api/v1/stats`

**Status:** Proposed 2026-08-10, not implemented. Adds one read-only route that
answers corpus-level questions about the calling tenancy's own posts. Originates
from a Vox Pop proposal written against the deployed surface (`specs/admin-dashboard.md`
§ 6.5–6.6 in `bbthorson/vox-pop`); this document is the Antiphony-side decision,
and it **diverges from that proposal in four places** — see § 9.

## The ask

| | |
|---|---|
| **Add** | One route — `GET /api/v1/stats`, service-token gated, actor-less. |
| **Returns** | Post counts for the calling tenancy: totals plus fixed 24h and 7d windows. |
| **Costs** | **Two** new composite indexes. No new fields, no counters, no backfill. |
| **Does not** | Enumerate posts, break down by author, accept arbitrary date ranges, or return any user data. |

---

## 1. Motivation — a tenant cannot currently count its own posts

Verified against the deployed surface:

- `GET /api/v1/posts` runs `requireAuth()` (`adapters/inbound/rest/posts.ts`,
  `listRoute`), so an acting actor is mandatory, and both slices it serves are
  actor-scoped by construction — `queryByAuthor` (posts authored by the viewer)
  and `queryByRootAuthor` (replies whose thread root that author wrote), both in
  `adapters/outbound/firebase/audio-posts-dependencies.ts`.
- `GET /api/v1/posts/{postId}` and `/{postId}/replies` are single-document and
  single-thread respectively.

There is **no tenancy-wide query anywhere on the surface**. Corpus-level questions
— how many prompts exist, how much was posted this week — are therefore not merely
expensive for a caller to compute but impossible: without enumeration there is
nothing for a caller-side reconciliation job to read.

> This is a platform-shaped gap rather than one product's feature request. Any
> application calling Antiphony holds only the records it created a shadow for;
> the service is the sole party that can see the tenancy whole.

---

## 2. Scope guard — why this belongs in a "posts and audio only" surface

[`core-surface.md`](./core-surface.md) trims the public API to posts and audio and
holds that Antiphony stores **zero user data** — author identity travels as opaque
references, hydrated by the caller. A stats endpoint has to stay inside that line,
and it does: **counting posts is posts data.**

The boundary is specific and belongs in the route's own documentation, because the
tempting additions are exactly the ones that would cross it:

| Field | Verdict | Why |
|---|---|---|
| `totals.posts` / `prompts` / `replies` | **Include** | Aggregate over records the service owns. No subject beyond the tenancy itself. |
| `windows.last24h` / `last7d` | **Include** | Same aggregate, bounded by `createdAt`. Separates historical drift from ongoing drift — see § 5. |
| `topAuthors`, `activeAuthors` | **Refuse** | Assertions about people. Re-imports the user-data surface the trim removed. |
| `from` / `to` range parameters | **Refuse** | Turns a stats endpoint into an analytics API and invites unbounded scans. |
| Cross-tenancy or global totals | **Refuse** | Tenancy comes from the credential. There is no legitimate caller for another's numbers. |

---

## 3. Contract

Standard envelope. `requireServiceToken()` — the request is tenancy-scoped and
viewer-less, the same posture as an anonymous read, and any
`X-Antiphony-Acting-Actor` present is ignored rather than rejected.
`rateLimit(RATE_LIMITS.read)`.

```jsonc
// GET /api/v1/stats
// Authorization: Bearer <service-token>
{
  "success": true,
  "data": {
    "posts": {
      "totals":  { "posts": 4182, "prompts": 1204, "replies": 2978 },
      "windows": {
        "last24h": { "posts": 37,  "prompts": 4,  "replies": 33 },
        "last7d":  { "posts": 291, "prompts": 26, "replies": 265 }
      }
    },
    // The single read time all six aggregations were taken at (§ 4.2).
    // Required — a caller must be able to show staleness rather than imply
    // live truth, and a cached response must be able to say so honestly.
    "asOf": "2026-08-10T14:02:11Z"
  }
}
```

### Why the counts nest under `posts`

The originating proposal put `totals`/`windows` at the top level and left the
route name open (`/api/v1/stats` vs `/api/v1/posts/stats`). Nesting resolves that
question rather than deferring it:

- **`/api/v1/posts/stats` is rejected.** It would sit in the module that owns
  `GET /posts/{postId}`, permanently reserving a path segment against a parameter
  route. Harmless in practice — post ids are 13-character TIDs, so `stats` can
  never be a real id — but it is a hazard taken on for no gain.
- **An audio-side counterpart becomes a sibling key, not a second route.** That
  was the only argument for the `/posts/` prefix, and namespacing the payload
  answers it better.

### Why `posts` is carried explicitly

`totals.posts` is not left as `prompts + replies`. The proposal justified this as
future-proofing against a third `kind`, which the data model forbids — `kind` is
denormalized from `reply` presence (`AudioPostRecordSchema`) and is binary by
construction. Two better reasons stand:

1. It is the only aggregation that needs no composite index (§ 4.1).
2. It is the number a dashboard actually renders, and deriving a headline figure
   client-side invites each caller to derive it slightly differently.

> A tenancy with zero posts returns zeros, not 404. The endpoint describes a
> tenancy, which always exists once the token matched.

---

## 4. Implementation

Post documents hold `originAppId`, `kind`, `createdAt`, `authorId`, and
`rootAuthorId`. `createdAt` is written as `deps.now()` — a `Date`, stored as a
Firestore `Timestamp` — and only two adapters ever write the `posts` collection
(`audio-posts-dependencies.ts`, `audio-processing-dependencies.ts`), so range
filters on it are sound. Every number above is therefore a Firestore `count()`
aggregation over an equality-plus-range query the collection is already shaped for.

The port stays **count-shaped**, never enumeration-shaped, so the "no tenancy-wide
enumeration primitive" property holds at the port boundary and not merely at the
route:

```ts
// packages/core/ports/audio-posts-dependencies.ts
/**
 * Count posts in a tenancy. Deliberately returns a scalar: adding a
 * tenancy-wide LIST primitive here would re-open the enumeration surface
 * that core-surface.md closed, for a question that only needs a number.
 */
countPosts(
    originAppId: string,
    options?: { kind?: 'prompt' | 'reply'; since?: Date },
): Promise<number>;
```

### 4.1 Two indexes, not one

`firestore.indexes.json` currently has four composites on `posts`. Each leads with
`originAppId` followed by a per-record facet (`authorId`; `authorId, kind`;
`reply.parent.uri`; `rootAuthorId`), so none can serve a tenancy-wide query.

The originating proposal added one index and claimed it covered all six
aggregations. **It covers four.** Firestore requires a composite index's equality
fields to form a *prefix* and has no index-skip-scan over an unconstrained middle
field, so an index of `(originAppId, kind, createdAt)` cannot serve a query that
constrains `originAppId` and `createdAt` but leaves `kind` open:

| Aggregation | Query shape | Served by |
|---|---|---|
| `totals.posts` | `originAppId ==` | automatic single-field index |
| `totals.prompts` / `.replies` | `originAppId ==`, `kind ==` | index **A** (equality prefix) |
| `windows.*.prompts` / `.replies` | `originAppId ==`, `kind ==`, `createdAt >=` | index **A** |
| `windows.last24h.posts` / `last7d.posts` | `originAppId ==`, `createdAt >=` | index **B** |

```json
// A — the kind-scoped aggregations, windowed and unwindowed
{
  "collectionGroup": "posts",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "originAppId", "order": "ASCENDING" },
    { "fieldPath": "kind",        "order": "ASCENDING" },
    { "fieldPath": "createdAt",   "order": "DESCENDING" }
  ]
},
// B — the kind-less windowed totals
{
  "collectionGroup": "posts",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "originAppId", "order": "ASCENDING" },
    { "fieldPath": "createdAt",   "order": "DESCENDING" }
  ]
}
```

**This is the one defect in this design that local testing cannot catch.** The
Firestore emulator does not enforce composite index requirements, so with index B
missing every unit test and every local run passes, and the two window totals fail
only against production Firestore, as `FAILED_PRECONDITION`, after the route ships.

The tempting one-index workaround — `kind in ['prompt', 'reply']`, which fans out
into equality queries index A can serve — is refused. It re-introduces exactly the
enumerate-the-kinds coupling that carrying `posts` explicitly exists to avoid, to
save an index that costs nothing until it is written to.

### 4.2 One read time for all six

Six independent `count()` calls execute at six read times. A post created mid-flight
makes `prompts + replies ≠ posts`, and because `posts` is carried as its own
aggregation (§ 3) a caller that sanity-checks the arithmetic will see it fail
intermittently and file a bug against the endpoint.

Issue all six inside a **read-only transaction at a pinned read time**. That makes
the numbers internally consistent and makes `asOf` a single honest value rather
than an approximation over a spread of six.

### 4.3 Cost, and when to cache

`count()` bills as **one document read per 1,000 index entries scanned** (minimum
one) — not per matched document, and not free. Concretely, for a full six-aggregation
call, dominated by the three unwindowed totals that scan the whole corpus:

| `totals.posts` | reads per call (approx.) |
|---|---|
| 4,000 | 15 |
| 100,000 | 330 |
| 1,000,000 | 3,000 |

Cheap now, linear in corpus size forever. **Cache when `totals.posts` crosses
~100,000**, as a short server-side TTL — which the required `asOf` field already
makes honest to expose. Writing the threshold down is the point: the proposal said
"the moment the totals become uncomfortable," which is not a number anyone can act
on.

Precomputed counter documents remain the wrong first move: they add write-path work
and contention plus a backfill, to optimize a query that is currently cheap.

### 4.4 Rate limiting

`rateLimit(RATE_LIMITS.read)` is 60/min keyed by **client IP**
(`middleware/rate-limit.ts`), not by token. A BFF egresses from a handful of
addresses, so a polling dashboard shares one bucket with all of that tenant's other
reads. Fine at a sane poll interval; document it so nobody sets the dashboard to 5s
and rate-limits their own product.

---

## 5. What this is for: a tripwire, not a reconciler

The dashboard number is the obvious use. The second use — letting a caller with its
own app-layer mirror detect divergence — is real but must be stated precisely,
because the originating proposal claimed more than a scalar can deliver.

```
platform · prompts    1,204  ████████████████████████████████
app layer · known       900  ████████████████████████
unaccounted             304                          ████████
```

A scalar **detects** divergence. It cannot **localize** it. When the endpoint says
1,204 and the caller knows 900, nothing in the response says which 304, and some of
that gap is structural and expected — a caller whose mirror is created lazily will
legitimately not know about records with no activity. A monitor whose healthy value
is an unknown nonzero number that drifts is not a monitor.

**The windows are what make this actionable**, and this is their strongest
justification. If `last24h` ties out but the totals do not, the divergence is
historical rather than ongoing — a past incident, not a currently-broken write path.
If `last24h` diverges too, something is failing right now. That distinction is
worth paging on; a bare total is not.

So: this endpoint is the **tripwire**. Localization is a separate mechanism (§ 6),
and the two are complementary rather than alternatives.

---

## 6. Alternatives considered

| Option | Why not |
|---|---|
| Caller-side reconciliation | Structurally impossible. No tenancy-wide enumeration exists to read (§ 1). |
| Widen `GET /posts` to allow a viewer-less tenancy listing | Strictly worse. Adds an enumeration primitive and a pagination burden to answer a question that only needs a scalar. |
| Maintained counter documents | Write-path cost, contention, and a backfill — to optimize a query that is currently cheap. Revisit per § 4.3. |
| Expose Prometheus metrics instead | Different audience. Those describe the *service* to its operator; this describes a *tenancy* to its owner, who has no access to the deployment. |
| **A `post.created` webhook instead** | **Not instead — alongside.** See below. |

### The `post.created` webhook

An outbound core→BFF push channel already exists in code: `ProcessingNotifierPort`
(`packages/core/ports/processing-notifier.ts`) with a wired HMAC HTTP adapter
(`adapters/outbound/webhook/notifier.ts`), spec'd in
[`enrichment-webhooks.md`](./enrichment-webhooks.md). It currently fires only when
an enrichment stage settles. A `post.created` event on that same seam would tell a
caller **which** post ids it is missing — the localization a scalar cannot provide.

That does not displace this endpoint. `enrichment-webhooks.md` establishes the push
channel as best-effort by design ("an accelerator, never a source of truth"), so a
**dropped webhook is precisely the failure mode § 5 exists to catch**. A caller that
reconciled only from pushes would have no way to learn the push channel had dropped
something.

The division is clean, and each half is weak alone:

- **`GET /stats` — the tripwire.** Independent of the push path, so it can detect
  the push path failing.
- **`post.created` — the localizer.** Names the records, so a detected gap can be
  closed.

Sequencing: this endpoint first. It is smaller, it is the half that has no substitute,
and a `post.created` event is a contract addition to a spec that is itself still
proposed.

---

## 7. Resolved questions

The originating proposal left three open. Resolved here:

1. **Fixed windows, not a `since` parameter.** Fixed windows keep the query shape
   provably bounded and are what § 5 actually needs. A capped-lookback `since` is a
   later, additive change if a real caller needs it.
2. **`/api/v1/stats` with a `posts`-namespaced payload**, not `/api/v1/posts/stats`
   — see § 3.
3. **Yes, it goes in the published OpenAPI document.** It is a legitimate part of the
   tenant contract rather than an internal callback, so it inherits the versioning
   commitments in [`api-versioning.md`](./api-versioning.md). Additive → **patch**:
   contract `0.4.0` → `0.4.1`.

---

## 8. Execution checklist

Ports-and-adapters with a CI-locked surface, so "one route" is more than one file:

1. `countPosts(originAppId, { kind?, since? })` on `AudioPostDependencies`
   (`packages/core/ports/audio-posts-dependencies.ts`), count-shaped per § 4.
2. Firestore binding in
   `apps/core-api/src/adapters/outbound/firebase/audio-posts-dependencies.ts`,
   with the read-only pinned-read-time transaction of § 4.2.
3. Service method on `AudioPostService` (`packages/core/services/audio-posts.ts`)
   composing the six aggregations; fake binding in the core service tests.
4. Route module `adapters/inbound/rest/stats.ts` + mount in `app.ts` alongside
   `/api/v1/posts`. Document the § 2 boundary in the route's own description.
5. **Both** index entries in `firestore.indexes.json` (§ 4.1). Deploy indexes
   *before* the route — the emulator will not catch a missing one.
6. `npm run gen:openapi -w @antiphony/core-api`; commit the regenerated
   `openapi.json` **and** `openapi.surface.json` in the same PR, or
   `openapi-surface.test.ts` fails CI.
7. Bump `OPENAPI_INFO.version` (`lib/openapi-info.ts`) `0.4.0` → `0.4.1`.
8. `CHANGELOG.md` entry under `[0.4.1]`, additive, not breaking.
9. After merge, confirm the docs redeploy serves the new `openapi.json`.

---

## 9. Divergences from the originating proposal

Recorded so the reasoning is not re-litigated at PR time:

| # | Proposal | This spec | § |
|---|---|---|---|
| 1 | One composite index covers all six aggregations | **Two** indexes; one index leaves the two kind-less windowed totals unserved, and the emulator will not catch it | 4.1 |
| 2 | Six independent `count()` calls | One read-only transaction at a pinned read time, so the arithmetic ties out and `asOf` is a single value | 4.2 |
| 3 | `totals`/`windows` at the payload root; route name left open | Nested under `posts`; `/api/v1/stats` settled | 3 |
| 4 | Reconciliation is the primary value | Reconciliation *detection* is; localization needs `post.created`, which the alternatives table did not consider | 5, 6 |

Two smaller corrections carried inline: `count()` bills per 1,000 index entries as
document reads (not "per index entries matched"), which is what makes the § 4.3
caching threshold statable; and the "future third `kind`" argument for carrying
`totals.posts` explicitly is unsound — the field is kept for the two reasons in § 3.

---

*Verified against the deployed surface:
`apps/core-api/src/adapters/inbound/rest/posts.ts`,
`apps/core-api/src/adapters/outbound/firebase/audio-posts-dependencies.ts`,
`apps/core-api/src/middleware/auth.ts`, `packages/shared/types/audio.ts`,
`firestore.indexes.json`, `specs/service-auth.md`, `specs/core-surface.md`,
`specs/api-versioning.md`, `specs/enrichment-webhooks.md`.*
