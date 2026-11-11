# Tenancy stats — `dev.antiphony.tenant.getStats`

**Status:** Implemented 2026-11-11, contract 0.10.8. Proposed 2026-08-10. Adds one read-only
query that answers corpus-level questions about the calling tenancy's own posts, built
**XRPC-first** ([`xrpc-surface.md`](./xrpc-surface.md)): the lexicon
`dev.antiphony.tenant.getStats` is the contract, `GET /xrpc/dev.antiphony.tenant.getStats` is the
primary surface, and `GET /api/v1/stats` is a REST twin over the same service method. Originates
from a Vox Pop proposal written against the deployed surface (`specs/admin-dashboard.md`
§ 6.5–6.6 in `bbthorson/vox-pop`); this document is the Antiphony-side decision, and it
**diverges from that proposal in four places**, listed in § 9. The proposal and the first
version of this spec were written for Firestore; § 4 describes what was built on Postgres, and
§ 9 records the one addition made on the way (`remotePosts`).

## The ask

| | |
|---|---|
| **Add** | One query, `dev.antiphony.tenant.getStats` (`GET /xrpc/dev.antiphony.tenant.getStats`), and its REST twin `GET /api/v1/stats`. Service-token gated, actor-less. |
| **Returns** | Post counts for the calling tenancy: totals plus fixed 24h and 7d windows, for hosted posts (`posts`) and for registered remote posts (`remotePosts`). |
| **Costs** | No new indexes, fields, counters or backfill; the existing indexes serve every count (§ 4.2). |
| **Does not** | Enumerate posts, break down by author, accept arbitrary date ranges, or return any user data. |

---

## 1. Motivation — a tenant cannot currently count its own posts

Verified against the deployed surface:

- `GET /api/v1/posts` runs `requireAuth()` (`adapters/inbound/rest/posts.ts`,
  `listRoute`), so an acting actor is mandatory, and both slices it serves are
  actor-scoped by construction — `queryByAuthor` (posts authored by the viewer)
  and `queryByRootAuthor` (replies whose thread root that author wrote), both in
  `adapters/outbound/postgres/audio-posts-dependencies.ts` (written against the Firestore binding it replaced).
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

`dev.antiphony.tenant.getStats` is a query with **no parameters**; the tenancy is the credential's.
`requireServiceToken()`: the request is tenancy-scoped and viewer-less, the same posture as an
anonymous read, and any `X-Antiphony-Acting-Actor` present is ignored rather than rejected.
`rateLimit(RATE_LIMITS.read)` on both surfaces. XRPC answers the bare body and errors as
`{ error, message }`; REST wraps the same body in the standard envelope.

```jsonc
// GET /xrpc/dev.antiphony.tenant.getStats
// Authorization: Bearer <service-token>
{
  "posts": {
    "totals":  { "posts": 4182, "prompts": 1204, "replies": 2978 },
    "windows": {
      "last24h": { "posts": 37,  "prompts": 4,  "replies": 33 },
      "last7d":  { "posts": 291, "prompts": 26, "replies": 265 }
    }
  },
  // The same structure over the remote posts the tenant registered
  // (specs/audio-service-mode.md). Never counted in `posts`.
  "remotePosts": {
    "totals":  { "posts": 52, "prompts": 9, "replies": 43 },
    "windows": {
      "last24h": { "posts": 3,  "prompts": 0, "replies": 3 },
      "last7d":  { "posts": 20, "prompts": 2, "replies": 18 }
    }
  },
  // The single read time every number was taken at (§ 4.1), and the end of
  // both windows. Required: a caller must be able to show staleness rather
  // than imply live truth, and a cached response must be able to say so.
  "asOf": "2026-11-11T14:02:11.000Z"
}
// GET /api/v1/stats answers { "success": true, "data": <the above> }
```

The lexicons are `lexicons/dev/antiphony/tenant/getStats.json` and `defs.json` (`counts`,
`windows`, `postStats`), held to the Zod schemas in `packages/shared/types/stats.ts` by the
lexicon-parity test. A tenancy with no rows returns zeros, not 404.

### What a count is

- **`posts`** counts the tenant's rows in `posts`: hosted posts, in a space or not. A prompt is a
  row with no reply reference and a reply one with, which is the `kind` column.
- **`remotePosts`** counts the tenant's rows in `remote_posts` (migration 0006): the records it
  registered from other repos. A reply is a row with `reply_root_uri is not null`. This is the one
  addition to the August proposal, made by the owner when it was built: a tenant whose prompts live
  in other repos (a Vox Pop org on a group host) would otherwise see a total that leaves them out.
- **A window is by `created_at`**, counted back from `asOf`, and a row **exactly at the edge is
  inside it** (`created_at >= asOf - 24h`). For a hosted post `created_at` is when it was posted.
  For a remote post it is the `createdAt` its record claims, which is not when it was
  registered here, so a registration of an old record does not move a window. A reader who
  wants "registered recently" needs a different figure, which this is not.
- `windows.last7d` includes `windows.last24h`; neither is a disjoint bucket.

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

1. A caller can check the arithmetic: `prompts + replies = posts` holds in every figure because all
   are counted in one read (§ 4.1), which a total derived client-side could not show.
2. It is the number a dashboard actually renders, and deriving a headline figure
   client-side invites each caller to derive it slightly differently.

> A tenancy with zero posts returns zeros, not 404. The endpoint describes a
> tenancy, which always exists once the token matched.

---

## 4. Implementation

Built lexicon-first on Postgres, in the layers the other methods use:

| Layer | Where |
|---|---|
| Lexicon | `lexicons/dev/antiphony/tenant/getStats.json`, `defs.json` |
| Schema | `packages/shared/types/stats.ts` (`TenantStatsSchema`), `XRPC_NSID.GetStats` |
| Port and service | `packages/core/ports/tenant-stats-dependencies.ts`, `services/tenant-stats.ts` |
| Postgres binding | `apps/core-api/src/adapters/outbound/postgres/tenant-stats-dependencies.ts` |
| Surfaces | the XRPC route in `adapters/inbound/xrpc/index.ts`; `adapters/inbound/rest/stats.ts` (OpenAPI tag `Tenant`) |

The port stays **count-shaped**, never enumeration-shaped, so the "no tenancy-wide enumeration
primitive" property holds at the port boundary and not merely at the route:

```ts
// packages/core/ports/tenant-stats-dependencies.ts
countTenantPosts(
    originAppId: string,
    edges: { since24h: Date; since7d: Date },
): Promise<{ posts: PostStats; remotePosts: PostStats }>;
```

`TenantStatsService.getStats` reads its clock once, derives both edges from that instant, passes
them to the port and reports the instant as `asOf`. The clock is injected, which is how the
window-edge tests pin it.

### 4.1 One read time for every figure

Twelve independent counts would execute at twelve read times. A post created mid-flight makes
`prompts + replies ≠ posts`, and a caller that sanity-checks the arithmetic would see it fail
intermittently and file a bug against the endpoint.

The binding therefore issues **one SQL statement**, and a statement reads one snapshot. (The
`SqlClient` port has no interactive transaction on purpose; none is needed here.) Everything is
scoped by `origin_app_id`:

```sql
select
    h.prompts       as h_prompts,
    h.replies       as h_replies,
    h.prompts_24h   as h_prompts_24h,
    h.replies_24h   as h_replies_24h,
    h.prompts_7d    as h_prompts_7d,
    h.replies_7d    as h_replies_7d,
    (select count(*) from remote_posts
      where origin_app_id = $1)                                           as r_posts,
    (select count(*) from remote_posts
      where origin_app_id = $1 and reply_root_uri is not null)            as r_replies,
    (select count(*) from remote_posts
      where origin_app_id = $1 and created_at >= $2::timestamptz)         as r_posts_24h,
    (select count(*) from remote_posts
      where origin_app_id = $1 and reply_root_uri is not null
        and created_at >= $2::timestamptz)                                as r_replies_24h,
    (select count(*) from remote_posts
      where origin_app_id = $1 and created_at >= $3::timestamptz)         as r_posts_7d,
    (select count(*) from remote_posts
      where origin_app_id = $1 and reply_root_uri is not null
        and created_at >= $3::timestamptz)                                as r_replies_7d
  from (
    select
        count(*) filter (where kind = 'prompt')                                      as prompts,
        count(*) filter (where kind = 'reply')                                       as replies,
        count(*) filter (where kind = 'prompt' and created_at >= $2::timestamptz)    as prompts_24h,
        count(*) filter (where kind = 'reply'  and created_at >= $2::timestamptz)    as replies_24h,
        count(*) filter (where kind = 'prompt' and created_at >= $3::timestamptz)    as prompts_7d,
        count(*) filter (where kind = 'reply'  and created_at >= $3::timestamptz)    as replies_7d
      from posts
     where origin_app_id = $1
  ) h
```

`$1` is the tenant, `$2` and `$3` the 24h and 7d edges. `posts` is the sum of a split, and a remote
post's prompts are its rows less its replies, both computed from the same snapshot. `asOf` is the
service's clock, not the database's, for the reason `recordCheck` gives: it compares these
timestamps with its own `now()`. Rows created after `asOf` by a writer with a faster clock are
in the totals and the windows alike, so `windows` never exceeds `totals`.

### 4.2 No new index

The Firestore version of this spec needed two composite indexes, because Firestore wants a
query's equality fields to form an index prefix. The count queries here filter by `origin_app_id`,
sometimes `kind`, sometimes a `created_at` range, and the obvious port would add a Postgres index
for the windows. **Migration 0011 was considered and not written**, because the statement is
already served:

- Every index on `posts` and `remote_posts` that matters here leads with `origin_app_id`, so a
  count scoped to a tenant is a range scan on that prefix, and a filter on a later column in the
  same index is checked inside the index. Postgres needs no second index for the kind-less
  windowed counts that Firestore did.
- Hosted posts are **one index-only pass** over `posts_author_kind_created_idx`
  `(origin_app_id, author_id, kind, created_at, id)`, which holds every column the counts read.
  The window counts ride along in that pass. The totals need a pass over the tenant's entries
  whatever the indexes are, so an `(origin_app_id, created_at)` index would save the windows
  nothing while the totals are counted in the same statement, and would cost a write on every post.
- Each remote count is an index-only scan that starts at the tenant's entries. The windows range
  on `created_at` through `remote_posts_list_idx` and its per-repo sibling (migration 0010), and
  the reply counts read the partial `remote_posts_reply_root_idx` (migration 0006), which holds
  replies only.

Checked with `EXPLAIN (ANALYZE)` on PGlite over 30,000 posts and 20,000 remote posts for each of
two tenants, after `VACUUM ANALYZE`: every scan was index-only with `Heap Fetches: 0`, scoped
by `origin_app_id`, and none read the table. An index-only scan depends on the visibility map
being current, which autovacuum keeps; a table that is not vacuumed would fetch from the heap,
which is slower but not wrong.

**When this changes:** if the totals are ever cached (§ 4.3), the windows become the only
live counts, and an `(origin_app_id, created_at desc) include (kind)` index on `posts` is
then what makes them cheap. Add it with that change.

### 4.3 Cost, and when to cache

The cost is linear in the tenant's own row count and nothing else: one pass over the tenant's
`posts` index entries (about 300 buffers for 30,000 posts in the check above) and a handful of
narrower scans over its remote ones. There is no per-read billing as there was under Firestore,
so the cost is latency and database compute.

**Cache when `totals.posts` crosses roughly 100,000**, as a short server-side TTL, which the
required `asOf` field already makes honest to expose. The figure is carried over from the
Firestore version's billing arithmetic and has not been measured on Neon; treat it as the
point at which to measure, and write down what the measurement says. Writing a threshold at
all is the point: "the moment the totals become uncomfortable" is not a number anyone can act on.

Precomputed counter rows remain the wrong first move: they add write-path work and contention
plus a backfill, to optimize a query that is currently cheap.

### 4.4 Rate limiting

`rateLimit(RATE_LIMITS.read)` is 60/min keyed by **client IP** (`middleware/rate-limit.ts`),
not by token, on both surfaces. A BFF egresses from a handful of addresses, so a polling
dashboard shares one bucket with all of that tenant's other reads from that address. Fine at a sane
poll interval; document it so nobody sets the dashboard to 5s and rate-limits their own product.
It is not paired with the aggregate IP bucket the actor-keyed reads use, since it is not keyed
by anything a caller can mint.

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
   contract `0.10.7` → `0.10.8` (it was `0.4.0` → `0.4.1` when this was proposed).

---

## 8. What shipped

Ports-and-adapters with a CI-locked surface, so "one query" was more than one file. In the order
it was built, as one commit (contract 0.10.8):

1. The lexicons `tenant/getStats.json` and `tenant/defs.json`, with parity cases for `counts`,
   `windows`, `postStats` and the output in `lexicon-parity.test.ts`.
2. `packages/shared/types/stats.ts`, exported from the index and the build entries, and
   `XRPC_NSID.GetStats`.
3. `TenantStatsDependencies` and `TenantStatsService` in `packages/core`, with a fake in the
   service test.
4. The Postgres binding (§ 4.1) and its PGlite suite: zeros, tenant isolation, the split, the window
   edges under an injected clock, remote posts counted apart.
5. The XRPC route and `rest/stats.ts` (tag `Tenant`), each with a route test; wiring in
   `composition.ts`.
6. `OPENAPI_INFO.version` `0.10.7` → `0.10.8`, `npm run gen:openapi` (`openapi.json` and
   `openapi.surface.json`), and the `[0.10.8]` CHANGELOG entry.
7. No migration (§ 4.2).

**Still to do:** after merge, confirm the docs redeploy serves the new `openapi.json`. The
`@antiphony/shared` release waits with the other remote-post XRPC schemas.

---

## 9. Divergences from the originating proposal

Recorded so the reasoning is not re-litigated at PR time:

| # | Proposal | This spec | § |
|---|---|---|---|
| 1 | One composite index covers all six aggregations | Moot on Postgres: **no new index**, because the existing ones lead with `origin_app_id` and serve every count (the Firestore draft of this spec said two, since one leaves the kind-less windowed totals unserved there) | 4.2 |
| 2 | Six independent `count()` calls | One statement, so one snapshot: the arithmetic ties out and `asOf` is a single value | 4.1 |
| 3 | `totals`/`windows` at the payload root; route name left open | Nested under `posts`, with `remotePosts` a sibling; XRPC `dev.antiphony.tenant.getStats` is primary and `/api/v1/stats` its twin | 3 |
| 4 | Reconciliation is the primary value | Reconciliation *detection* is; localization needs `post.created`, which the alternatives table did not consider | 5, 6 |

Two smaller corrections carried inline: the "future third `kind`" argument for carrying
`totals.posts` explicitly is unsound, so the field is kept for the reasons in § 3; and the
§ 4.3 caching threshold was derived from Firestore billing and is now a point to measure,
not a measured limit.

**Added since the proposal, not a divergence from it:** `remotePosts` (§ 3), by the owner's decision
when it was built.

---

*Verified against the tree at contract 0.10.8:
`apps/core-api/src/adapters/inbound/rest/stats.ts`,
`apps/core-api/src/adapters/inbound/xrpc/index.ts`,
`apps/core-api/src/adapters/outbound/postgres/tenant-stats-dependencies.ts`,
`apps/core-api/migrations/0001_initial_schema.sql`, `0006_remote_posts.sql`,
`0010_remote_posts_list.sql`, `packages/shared/types/stats.ts`,
`lexicons/dev/antiphony/tenant/`, `specs/service-auth.md`, `specs/core-surface.md`,
`specs/api-versioning.md`, `specs/enrichment-webhooks.md`.*
