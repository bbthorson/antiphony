# XRPC Inbound Adapter & @atproto/lex Adoption Strategy

**Status:** Phase 1 implemented (August 2026); Phases 2–3 proposed, gated on a
concrete consumer. See §7.  
**Context:** Evaluation of upstream Lexicon tooling (Bluesky Protocol Services) and native XRPC service interfaces alongside Antiphony's REST API.  
**Related Specs:** [`atproto-authority-model.md`](./atproto-authority-model.md), [`core-bff-boundary.md`](./core-bff-boundary.md), [`core-surface.md`](./core-surface.md).

---

## 1. Executive Summary & Core Decisions

| Topic | Decision | Primary Rationale |
| :--- | :--- | :--- |
| **Upstream lexicon tooling** | **Adopt as a Dev/CI validation oracle (`@atproto/lex-document`); do NOT replace `@antiphony/shared` Zod runtime.** ✅ implemented | `@hono/zod-openapi` requires Zod schemas for OpenAPI 3.1 generation and REST route validation. `@atproto/lex` codegen produces static TypeScript types without runtime validation or OpenAPI metadata. |
| **XRPC Interface** | **Support native XRPC via a Hono inbound adapter (`/xrpc/*`) alongside REST (`/api/v1/*`).** | XRPC is HTTP under the hood. In Antiphony's hexagonal architecture, `/xrpc/*` is just another inbound adapter calling the same domain services (`PostService`, `AudioService`). |
| **Third-Party Adapters** | **Do NOT use third-party libraries (e.g. `xrpc-hono`).** | Rolling a native Hono sub-router takes <100 lines of code, preserves zero external dependency bloat, and avoids third-party version mismatch or maintenance lag. |
| **Data & Authority Boundary** | **Preserve App-as-Repo-Owner (Model B).** | `at://` authority remains the tenant's `did:web`. XRPC endpoints serve as service endpoints for the tenant's repository without leaking user keys or forcing un-redactable user DIDs into immutable CIDs. |

---

## 2. Background: Antiphony vs. Upstream ATProto Tooling

### The Current Antiphony Stack
Antiphony currently defines its lexicon schemas in `lexicons/dev/antiphony/`:
* `dev.antiphony.audio.post`
* `dev.antiphony.audio.transcript`
* `dev.antiphony.embed.audio`
* `dev.antiphony.embed.recordWithAudio`
* `dev.antiphony.actor.profile`

Runtime schema validation, response codecs, and TypeScript interfaces live in `packages/shared` via **Zod 3**. Antiphony’s core HTTP service (`apps/core-api`) uses **Hono** + **`@hono/zod-openapi`** to serve the `/api/v1/*` surface and compile `openapi.json` for live Scalar documentation.

The only runtime `@atproto` dependency is `@atproto/syntax` (used for strict TID and DID validation).

### Upstream Evolution: Bluesky Protocol Services, `@atproto/lex` & `@bsky/sdk`
Bluesky has transitioned from the monolithic `@atproto/api` package to a modular, modern toolchain:
1. **`@atproto/lex`**: Generic, protocol-level Lexicon tooling, codegen (`lex build`), and lightweight XRPC client primitives for *any* ATProto lexicon (`dev.antiphony.*`, etc.).
2. **`@bsky/sdk`**: High-level, opinionated TypeScript SDK specifically for Bluesky (`app.bsky.*` lexicons, RichText facet parsing, feed algorithms, and auth session helpers like `@atproto/lex-password-session`).
3. **`@atproto/lex-cli` / `lex` CLI**: Development workflow for pulling, linking, and building Lexicon schemas.

---

## 3. Why We Should (and Shouldn't) Adopt `@atproto/lex`

### What We SHOULD Do: Use Upstream Lexicon Tooling in CI & Testing
Adopt upstream tooling as a development/tooling dependency to:
1. **Validate Lexicons:** Ensure all schemas in `lexicons/dev/antiphony/*.json` strictly conform to the latest official Lexicon specification. Borrowing upstream's own encoding of the spec (rather than hand-rolling a validator) is the point: it moves when the spec moves, so drift arrives as a CI failure rather than a federation-time surprise.
2. **Oracle Contract Testing:** Run automated parity checks ensuring `@antiphony/shared` Zod schemas and types do not drift from the lexicon definitions.

The package that actually does this is **`@atproto/lex-document`** ("Lexicon document validation tools for AT"), which exports `lexiconDocumentSchema`. The `@atproto/lex` umbrella is the wrong dependency for the job — see §7 Phase 1.

### What We SHOULD NOT Do: Replace `@antiphony/shared` Zod Runtime
We should **not** discard our Zod schemas in favor of generated `@atproto/lex` types because:
1. **OpenAPI & Scalar Documentation Loss:** `@hono/zod-openapi` requires Zod objects (`z.object({...}).openapi(...)`) to build the OpenAPI 3.1 specification. Generated `@atproto/lex` types provide compile-time types but zero runtime metadata for OpenAPI generation.
2. **Runtime Boundary Defense:** Antiphony enforces runtime sanitization and field constraints on untrusted HTTP payloads before passing data into domain ports.
3. **Dual ESM/CJS Package Isolation:** `@antiphony/shared` has zero dependencies other than `zod`, making it trivial to embed in external TypeScript and Node.js environments.

### 3.3 Where `@bsky/sdk` Belongs: In Hosted BFFs & Connectors, NOT the Open Core
A critical architectural boundary exists between **`@atproto/lex`** and **`@bsky/sdk`**:
* **Open Core (`antiphony` repo):** Antiphony is headless, application-agnostic, and owns only the `dev.antiphony.*` lexicons and storage pipelines. It deliberately does *not* know about Bluesky social feeds, `app.bsky.*` records, or Bluesky user sessions. Thus, `@bsky/sdk` is **not installed in the open-core repo**.
* **Hosted Applications & Connectors (e.g. Vox Pop, BFFs, publishing bots):** When an application built on Antiphony wants to crosspost audio prompts to Bluesky timelines, render Bluesky RichText facets, or authenticate users via Bluesky OAuth/app passwords, **`@bsky/sdk` is the exact modern package to use** (completely replacing `@atproto/api`).

---

## 4. Architecture: Native XRPC on Hono

Because XRPC is standard HTTP (`GET /xrpc/<NSID>` for queries, `POST /xrpc/<NSID>` for procedures), Antiphony can expose both REST and XRPC from the same Hono instance with zero architectural friction.

### Dual-Mount Inbound Adapter Pattern

```
                       ┌───────────────────────────────┐
                       │    Hono Server (core-api)     │
                       └───────────────┬───────────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                ▼                                             ▼
     REST Inbound Adapter                           XRPC Inbound Adapter
   (/api/v1/posts, /audio, ...)                   (/xrpc/dev.antiphony.*)
                │                                             │
                │     (Translates HTTP/Zod)                   │     (Translates XRPC/NSID)
                └──────────────────────┬──────────────────────┘
                                       ▼
                       Core Domain Services / Ports
                       (PostService, AudioService, etc.)
                                       │
                                       ▼
                       Storage & Outbound Adapters
                       (Firestore, Cloud Storage, ElevenLabs)
```

### Route Mapping

| Capability | Traditional REST (`/api/v1/*`) | ATProto XRPC (`/xrpc/*`) | Method |
| :--- | :--- | :--- | :--- |
| **Fetch Post** | `GET /api/v1/posts/:postId` | `GET /xrpc/dev.antiphony.audio.getPost?id=<rkey>` | Query |
| **List Post Thread** | `GET /api/v1/posts/:postId/thread` | `GET /xrpc/dev.antiphony.audio.getThread?id=<rkey>` | Query |
| **Create Audio Post** | `POST /api/v1/posts` | `POST /xrpc/dev.antiphony.audio.createPost` | Procedure |
| **Get Playback URL** | `GET /api/v1/audio/:cid/playback` | `GET /xrpc/dev.antiphony.audio.getPlaybackUrl?cid=<cid>` | Query |
| **Request Reprocess** | `POST /api/v1/posts/:postId/reprocess` | `POST /xrpc/dev.antiphony.audio.reprocessPost` | Procedure |

---

## 5. Implementation Design

### 5.1 Method NSIDs Are Siblings of Record NSIDs

XRPC query and procedure names are **not** children of the record NSID. The
record is `dev.antiphony.audio.post`; the query that fetches it is
`dev.antiphony.audio.getPost` — both sit under the `dev.antiphony.audio`
authority segment. Deriving a method name by appending to `NSID.AudioPost`
would produce `dev.antiphony.audio.post.getPost`, which is a different (and
undefined) namespace.

Phase 2 therefore adds a distinct map to `packages/shared/nsid.ts`, alongside
the existing `NSID` and `EMBED_NSID` exports:

```ts
/**
 * XRPC method NSIDs. Siblings of the record NSIDs in `NSID` — a method shares
 * the authority segment (`dev.antiphony.audio`) but never nests under the
 * record name.
 */
export const XRPC_NSID = {
    GetPost: 'dev.antiphony.audio.getPost',
    GetThread: 'dev.antiphony.audio.getThread',
    CreatePost: 'dev.antiphony.audio.createPost',
    GetPlaybackUrl: 'dev.antiphony.audio.getPlaybackUrl',
    ReprocessPost: 'dev.antiphony.audio.reprocessPost',
} as const;
```

### 5.2 Native XRPC Router Implementation (`apps/core-api/src/adapters/inbound/xrpc/`)

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { XRPC_NSID } from '@antiphony/shared/nsid';
import { AudioPostRecordSchema } from '@antiphony/shared';
import type { PostService } from '../../../core/services/post-service.js';

export function createXrpcRouter(postService: PostService): Hono {
    const xrpc = new Hono();

    // XRPC error envelope — deliberately NOT the REST `{ success, error }`
    // envelope. See §5.3 for why the auth middleware needs a branch here.
    xrpc.onError((err, c) => {
        return c.json({
            error: 'InternalServerError',
            message: err.message || 'An unexpected error occurred',
        }, 500);
    });

    // Query: dev.antiphony.audio.getPost
    xrpc.get(`/${XRPC_NSID.GetPost}`, async (c) => {
        const id = c.req.query('id');
        if (!id) {
            return c.json({ error: 'InvalidRequest', message: 'Missing required parameter: id' }, 400);
        }
        // Tenancy comes from the credential, never the query string (§5.3).
        const post = await postService.getPostById(id);
        if (!post) {
            return c.json({ error: 'RecordNotFound', message: `Post not found: ${id}` }, 404);
        }
        return c.json(post);
    });

    // Procedure: dev.antiphony.audio.createPost
    xrpc.post(
        `/${XRPC_NSID.CreatePost}`,
        zValidator('json', AudioPostRecordSchema, (result, c) => {
            if (!result.success) {
                return c.json({
                    error: 'InvalidRequest',
                    message: 'Payload failed schema validation',
                    details: result.error.flatten(),
                }, 400);
            }
        }),
        async (c) => {
            const body = c.req.valid('json');
            const created = await postService.createPost(body);
            return c.json(created, 200);
        }
    );

    return xrpc;
}
```

### 5.3 Auth & Tenancy: Reuse the Service-Auth Contract

`/xrpc/*` is an inbound adapter, not a new trust boundary. It reuses the
implemented service-auth model in [`service-auth.md`](./service-auth.md)
verbatim — the same `requireAuth` / `optionalAuth` middleware, the same
headers, the same tenancy derivation:

| Concern | Behavior on `/xrpc/*` |
| :--- | :--- |
| **Caller identity** | `Authorization: Bearer <service-token>`, identical to REST. XRPC's own inter-service JWT auth is explicitly **out of scope** for Phase 2 — Antiphony is not a PDS and its callers are applications, not federated servers. |
| **Acting actor** | `X-Antiphony-Acting-Actor` on procedures and viewer-scoped queries; `X-Antiphony-Acting-Actor-Did` optional. |
| **Tenancy** | `originAppId` derived from the credential, never from an NSID parameter or request body. A query parameter naming another tenancy is ignored, not honored. |
| **Anonymous reads** | Queries mount under `optionalAuth` and return the public projection when no token is present. Procedures always require auth. |

**Error-shape collision.** The shared auth middleware emits the REST envelope
`{ success: false, error: { message } }`. XRPC requires `{ error, message }`.
A 401 raised by middleware mounted above the router would therefore return the
wrong shape to XRPC clients. Phase 2 must make the auth middleware
envelope-aware — either by branching on the mount path, or (preferred) by
having it throw a typed `AuthError` that each adapter's `onError` serializes in
its own dialect. This is a prerequisite, not a follow-up: the first
unauthenticated `/xrpc/*` request exercises it.

**Blob egress.** `getPlaybackUrl` returns a short-lived signed URL and is
tenancy-scoped like every other read; it never proxies raw blob bytes. See §6.

### 5.4 XRPC Error Standardization

All XRPC endpoints conform to the AT Protocol XRPC error specification:
```json
{
  "error": "InvalidRequest",
  "message": "Human readable description of the error"
}
```
Standard ATProto error symbols used:
* `InvalidRequest` (400)
* `AuthenticationRequired` (401)
* `Forbidden` (403)
* `RecordNotFound` (404)
* `RateLimitExceeded` (429)
* `InternalServerError` (500)

---

## 6. Atmosphere & Ecosystem Risks & Mitigations

| Ecosystem Risk | Impact on Audio Infrastructure | Antiphony Mitigation |
| :--- | :--- | :--- |
| **Public-by-default firehose** | Private/gated audio cannot be pushed naively to public MST repos. | Antiphony stores canonical records locally and allows tenant-controlled publishing. |
| **Audio Blob Egress Costs** | Open scrapers/relays hammering audio files can incur massive bandwidth bills. | Audio files are stored content-addressed in Cloud Storage; XRPC queries return **short-lived signed URLs** rather than unbounded raw blob streams. |
| **`app.bsky.*` Lexicon Siloing** | Bluesky's official app will not natively render `dev.antiphony.*` widgets without an embed adapter. | Posts support projection into standard `app.bsky.embed.external` or `app.bsky.embed.record` envelopes when bridging to Bluesky feeds. |
| **Upstream Tooling Churn** | Breaking changes in `@atproto/*` libraries breaking compilation. | Zero runtime dependencies on experimental `@atproto` packages. Core runtime relies strictly on stable `hono` and `zod`. |

---

## 7. Rollout Plan

1. **Phase 1: Lexicon Tooling & CI Validation** — ✅ **implemented** (PR #84).
   * `@atproto/lex-document` as a root devDependency — **not** the `@atproto/lex`
     umbrella this document originally named. The document schema is the whole
     requirement; the umbrella additionally pulls in the CLI, codegen, network
     resolver, and yargs, and does not even re-export `lexiconDocumentSchema`.
   * `npm run test:lexicons` (`scripts/validate-lexicons.mjs`) validates every
     document in `lexicons/` against `lexiconDocumentSchema`, asserts path/id
     agreement, and resolves all internal refs.
   * `packages/shared/types/lexicon-parity.test.ts` compares each lexicon def
     against the Zod schema mirroring it — property sets, required-vs-optional,
     `maxLength`, integer and array-element bounds. Legitimate divergences
     (storage-layer fields, `$type`, `labels` → `selfLabels`) are declared
     per-case, so an undeclared divergence fails and a stale declaration fails
     too.
   * Both run under `npm test`, which CI already invokes.

   **Known scope line:** refs into other authorities (`app.bsky.*`,
   `com.atproto.*`) are reported but not resolved. Resolving them means running
   `lex install`, which vendors ~20 third-party documents (~140 KB of
   `app.bsky.*`, `com.atproto.*`, `tools.ozone.*`) into `lexicons/` plus a
   CID-pinned `lexicons.json` manifest, and puts either a network fetch or that
   manifest in the CI path. Worth revisiting if a ref typo into a foreign
   authority ever reaches production; deliberately not paid for up front.

2. **Phase 2: Inbound XRPC Router** — *gated on a concrete consumer; see below.*
   * Make the auth middleware envelope-aware (§5.3). Prerequisite, not follow-up.
   * Add `XRPC_NSID` to `packages/shared/nsid.ts` (§5.1).
   * Create `apps/core-api/src/adapters/inbound/xrpc/`.
   * Implement queries and procedures for `dev.antiphony.audio.*` and `dev.antiphony.embed.*`.
   * Mount at `/xrpc/*` on the main Hono application, under the same auth middleware as REST.

**Sequencing.** Phase 1 was self-contained and stood on its own merits — one
devDependency and a CI script, catching Zod/lexicon drift that nothing else
detected — so it landed independently of the rest of this document. Phases 2–3
commit the project to a second permanent public surface (its own error dialect,
its own auth branch, its own egress profile). Nothing in the repo consumes
`/xrpc/*` today. Build it when a caller exists, not because this document
exists.

3. **Phase 3: Service Discovery & DID Document Integration**
   * In tenant `did:web` documents (`/.well-known/did.json`), advertise the XRPC service endpoint:
     ```json
     {
       "id": "#antiphony_audio",
       "type": "AntiphonyAudioService",
       "serviceEndpoint": "https://api.antiphony.dev"
     }
     ```
