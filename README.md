# Antiphony

**Call-and-response audio infrastructure.** Antiphony is a headless service other
applications call to store and retrieve audio posts in an interoperable,
AT-Protocol-shaped format — plus audio enrichment (transcription, and opt-in
cleanup like denoising, trimming and waveform peaks). It owns the canonical
`dev.antiphony.*` data model, the audio-embed lexicon contribution, and the public
REST surface that applications build on. Docs: [docs.antiphony.dev](https://docs.antiphony.dev).

## Status

- **Pre-1.0.** The API contract is at `0.x` (currently `0.8.0`, the
  `info.version` in [`apps/core-api/openapi.json`](apps/core-api/openapi.json)),
  served under the `/api/v1/` URL major. While `0.x`, a **breaking** contract
  change bumps the minor and an additive change or fix bumps the patch — see
  [`specs/api-versioning.md`](specs/api-versioning.md). Every contract change is
  recorded in [`CHANGELOG.md`](CHANGELOG.md).
- **Deployed:** the API at `api.antiphony.dev` (a Cloudflare Worker) and the docs
  at `docs.antiphony.dev`. Tenants are provisioned by the operator — there is no
  self-serve signup — so to build against Antiphony today you either get a service
  token from the operator or [run your own](https://docs.antiphony.dev/self-hosting/quick-start/).
- **Published:** [`@antiphony/shared`](https://www.npmjs.com/package/@antiphony/shared)
  (the contract: Zod schemas, codecs, NSIDs) and
  [`@antiphony/capture-kit`](https://www.npmjs.com/package/@antiphony/capture-kit)
  (headless browser recording and playback), both `0.x`.
- **First consumer:** [Vox Pop](https://voxpop.audio), a separate codebase whose
  backend calls this API over HTTP and depends on `@antiphony/shared`.

## Quickstart

Antiphony is called by an **application** (a BFF or worker), not directly by
end-user browsers. Every data route takes your app's service token, plus the id
of the end user acting on a write. The values below are placeholders — a service
token is issued by whoever runs the deployment (`ANTIPHONY_APP_TOKENS`); see
[`specs/service-auth.md`](specs/service-auth.md).

```bash
API=https://api.antiphony.dev          # or http://localhost:8787 for `npm run dev`
TOKEN='<your-app-service-token>'       # placeholder
ACTOR='<your-internal-user-id>'        # placeholder

# 1. Upload audio. Returns { success: true, data: { blob } } — a content-addressed
#    blob ref to pass verbatim as the post's embed.audio.
curl -sS "$API/api/v1/audio/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Antiphony-Acting-Actor: $ACTOR" \
  -F "file=@prompt.webm;type=audio/webm"

# 2. Create an audio post with that blob. Returns { success: true, data: { postId } }.
curl -sS "$API/api/v1/posts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Antiphony-Acting-Actor: $ACTOR" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
        "text": "What should we cover next week?",
        "embed": {
          "$type": "dev.antiphony.embed.audio",
          "audio": { "$type": "blob", "ref": { "$link": "<cid from step 1>" },
                     "mimeType": "audio/webm", "size": 48213 }
        },
        "processing": { "transcribe": true }
      }'

# 3. Fetch it back — the hydrated view, with a playable embed.url.
#    Omit X-Antiphony-Acting-Actor for an anonymous (viewer-less) read.
curl -sS "$API/api/v1/posts/<postId>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Antiphony-Acting-Actor: $ACTOR"
```

Every JSON response uses the envelope `{ success: true, data }` /
`{ success: false, error, requestId }`. Further reading:

- [API reference](https://docs.antiphony.dev/api/overview/) — auth, envelope,
  limits, and the [generated per-endpoint reference](https://docs.antiphony.dev/api/reference/)
- [`lexicons/`](lexicons/) — the `dev.antiphony.*` records, the contract you
  design against
- [Self-hosting quick start](https://docs.antiphony.dev/self-hosting/quick-start/)
- [`deploy/README.md`](deploy/README.md) — deploying to Cloudflare
- [`specs/`](specs/README.md) — design specs, with their status

## Workspaces

| Package | Role |
| :--- | :--- |
| `packages/shared` (`@antiphony/shared`) | Records, views, codecs, NSIDs — the published contract. Dual ESM/CJS build. |
| `packages/capture-kit` (`@antiphony/capture-kit`) | Headless browser audio primitives for Antiphony clients (microphone recorder, playback hook, client-side waveform peaks). Dual ESM/CJS build. |
| `packages/tokens` (`@antiphony/tokens`) | Antiphony design system tokens — Two Voices duotone palette, typography, spacing, surface, and audio waveform variables. |
| `packages/core` (`@antiphony/core`) | Backend-free domain services + ports (hexagonal). No vendor SDK imports, lint-enforced. |
| `apps/core-api` (`@antiphony/core-api`) | Hono REST + XRPC API on Cloudflare Workers — wires `core` ports to Neon and R2 bindings, serves `/api/v1/*` and `/xrpc/*`. |
| `apps/docs` (`@antiphony/docs`) | Astro/Starlight docs site, deployed to the `antiphony-docs` Worker (see `wrangler.jsonc`). |
| `apps/audio-rendition` (`@antiphony/audio-rendition`) | The one service that is not a Worker: an ffmpeg container on Cloud Run that derives renditions into R2 and backs the `trim` / `waveform` stages. |
| `apps/reference` (`@antiphony/reference`) | Minimal Vite/React reference client that drives the published contract end to end. |
| `lexicons/dev/antiphony/` | AT Protocol lexicon definitions (`audio.*`, `embed.*`, `actor.profile`). |

## Commands

```bash
npm install
npm run build        # build @antiphony/shared (dual), @antiphony/capture-kit (dual), bundle core-api (gen OpenAPI), and audio-rendition
npm run typecheck    # all workspaces
npm run lint         # all workspaces
npm run test         # all workspaces + root suites (eslint rules, lexicons, dependency ranges, design tokens)
npm run dev          # core-api on :8787 via `wrangler dev` (needs apps/core-api/.dev.vars)
npm run knip         # dead code/exports/deps sweep (CI gate with --treat-config-hints-as-errors)
```

## Releasing

`@antiphony/shared` and `@antiphony/capture-kit` are the two published packages.
Releases are cut by package-prefixed tag — `.github/workflows/release.yml` does the
publishing to npm, so no one needs npm credentials locally.

```bash
# 1. bump the version in the target package.json, land it on master
#    packages/shared/package.json -> "version": "0.8.0"
#    or packages/capture-kit/package.json -> "version": "0.1.0"
# 2. tag the merge commit and push the tag
git tag shared-v0.8.0 && git push origin shared-v0.8.0
# or
git tag capture-kit-v0.1.0 && git push origin capture-kit-v0.1.0
```

The workflow re-runs typecheck, lint, knip, test, and build, then asserts the tag
matches the selected package's `package.json` and that the version is unclaimed on
the registry, before publishing. A version with a prerelease identifier
(`shared-v0.8.0-rc.1`) publishes under the `next` dist-tag rather than `latest`.

`workflow_dispatch` runs the same pipeline with a `package` choice (`shared` or
`capture-kit`) and a `dry_run` input (default on) to validate a release without publishing.

Authentication is npm [trusted publishing](https://docs.npmjs.com/trusted-publishers)
over OIDC — there is no `NPM_TOKEN` secret. The trust policy on npmjs.com names
this repo **and the workflow filename**, so renaming `release.yml` breaks
publishing until the policy is updated. Note that a brand-new package name must be
published once manually (`npm publish -w @antiphony/<pkg> --access public`) before
its trusted publisher policy can be configured on npmjs.com.

Note that `CHANGELOG.md` tracks the **API contract** version, not package
releases; the two version lines are independent.

## Community

[CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) (report
vulnerabilities privately) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## History

This repository was extracted from the Vox Pop monorepo with full git history
(`git filter-repo` over `packages/{core,shared}`, `apps/core-api`,
`lexicons/dev/antiphony`, `eslint-rules`). The extraction is complete: Vox Pop no
longer carries an in-repo copy of the platform. It calls the deployed API over
HTTP and consumes the published contract, pinning `@antiphony/shared` exactly
(currently `0.7.0`).
