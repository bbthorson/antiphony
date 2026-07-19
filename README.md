# Antiphony

**Call-and-response audio infrastructure.** Antiphony is a headless service other
applications call to store and retrieve audio posts in an interoperable,
AT-Protocol-shaped format — plus audio enrichment (transcription, and opt-in
cleanup like denoising). It owns the canonical `dev.antiphony.*` data model, the
audio-embed lexicon contribution, and the public REST surface that products
(e.g. [Vox Pop](https://voxpop.audio)) build on. Docs: [docs.antiphony.dev](https://docs.antiphony.dev).

## Workspaces

| Package | Role |
| :--- | :--- |
| `packages/shared` (`@antiphony/shared`) | Records, views, codecs, NSIDs — the published contract. Dual ESM/CJS build. |
| `packages/core` (`@antiphony/core`) | Firebase-free domain services + ports (hexagonal). |
| `apps/core-api` (`@antiphony/core-api`) | Hono REST API on Firebase App Hosting — wires `core` ports to Firebase bindings, serves `/api/v1/*`. |
| `apps/docs` (`@antiphony/docs`) | Astro/Starlight docs site, deployed to Cloudflare (see `wrangler.jsonc`). |
| `apps/reference` (`@antiphony/reference`) | Minimal Vite/React reference client that drives the published contract end to end. |
| `lexicons/dev/antiphony/` | AT Protocol lexicon definitions (`audio.post`, `audio.transcript`, `embed.audio`, `embed.recordWithAudio`, `actor.profile`). |

## Commands

```bash
npm install
npm run build        # build @antiphony/shared (dual) + bundle core-api + gen OpenAPI
npm run typecheck    # all workspaces
npm run lint         # all workspaces
npm run test         # all workspaces
npm run dev          # core-api on :8090 (emulator mode)
```

## History

This repository was extracted from the Vox Pop monorepo with full git history
(`git filter-repo` over `packages/{core,shared}`, `apps/core-api`,
`lexicons/dev/antiphony`, `eslint-rules`). Vox Pop continues to run on its in-repo
copy and migrates onto the published `@antiphony/*` packages last.
