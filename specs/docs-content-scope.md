# Docs content scope — core (Antiphony) vs. app-layer

**Status:** decided 2026-06-27; ✅ **the docs site shipped** against this definition
(`docs.antiphony.dev`, Cloudflare Pages). The boundary table below is the durable
content; the Stream-3/4 execution notes near the end are historical.

The Antiphony docs site (`docs.antiphony.dev`) documents the **protocol + infra** —
not any product built on top of it (Vox Pop, Bardcast). This note draws the line so
a page either clearly belongs or clearly doesn't.

## The boundary

| In core docs (Antiphony protocol/infra) | App-layer — NOT in core docs |
| :--- | :--- |
| **Lexicons** — `audio.post`, `embed.audio`, `audio.transcript`, `actor.profile` (the lexicon spec is the adopter **crown jewel**) | **Organizations** — teams, membership, roles, invites, org profiles |
| **REST** — posts, audio (upload / signed-URL / transcript) | **Profiles, handles, identity-linking auth** — moved to the BFF (see [`core-bff-boundary.md`](./core-bff-boundary.md)); legacy `prompts` / `replies` (superseded by `posts`) |
| **Multi-tenancy** — `originAppId` isolation + directional sharing at the AppView | Product connectors as a *feature* (the telephony impl is closed Tier-2) |
| **Self-hosting** + **build-your-own** | App enrichments (sentiment, character attrs, social-video) |

## Why organizations is app-layer

- The protocol has no "organization" primitive. atproto identity is a **DID/actor**;
  grouping people into teams (membership, roles, invites, billing, org profiles) is
  SaaS/product machinery layered on top. Bluesky has no org lexicon; neither does Antiphony.
- In our data model `org` appears only as an **opaque indexed facet** (`orgId` on
  `AudioPostRecord`). The tenancy boundary is `originAppId`, not orgs. Core stores and
  filters by an opaque `orgId`; it never defines what an org *is* or manages its lifecycle.
- Same line we drew for private owner data (phone/email/settings/CRM): content protocol
  vs. control-plane/product. Organizations sit on the product side.

`orgId` survives in core docs only as: *"apps may tag records with an org id; core treats
it as an opaque scoping/filter key."* Nothing more.

## The two judgment calls (resolved)

- **Connectors / capture-doors.** The *concept* of capture channels (telephony, web,
  embed) is part of what Antiphony is → documented conceptually under architecture /
  build-your-own. The connector **management surface** (config CRUD, enable/disable) and
  the closed telephony implementation are app/ops-layer → out of core docs.
- **Auth.** Identity-linking (atproto connect/disconnect — about the actor's DID) is core.
  Session/cookie mechanics (`POST /auth/session`, dashboard login) are infra/app → out.

## Codebase implication — ✅ done

The `Organizations`, `prompts`, and `replies` resources (the **Stream-4 carve-out**) have
been **removed from `apps/core-api`** and live in the Vox Pop app layer. Core's public
surface is now `posts` + `audio` only; there is no longer anything to "not present as core."

## Also for Stream 3 — ✅ done

All shipped:

- The hand-written **lexicon spec** ([`/lexicons/overview`](https://docs.antiphony.dev/lexicons/overview/))
  is the adopter-facing reference; the generated endpoint list is a secondary aid, not the star.
- Rebranded Vox Pop → Antiphony; the OpenAPI copy targets `https://api.antiphony.dev/openapi.json`.
- Hosted on **Cloudflare Pages** at `docs.antiphony.dev`.
