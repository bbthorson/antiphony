# Antiphony Documentation

This directory (`@antiphony/docs`) contains the source for the [Antiphony](https://docs.antiphony.dev) documentation site, built with [Astro Starlight](https://starlight.astro.build/). It deploys to **Cloudflare Pages** at `docs.antiphony.dev`.

## Local development

From the repo root:

```bash
npm install
npm run dev -w @antiphony/docs      # local dev server at localhost:4321
npm run build -w @antiphony/docs    # production build to apps/docs/dist/
npm run preview -w @antiphony/docs  # preview the production build locally
```

`npm run dev`/`build` first run `scripts/copy-openapi.mjs`, which copies
`apps/core-api/openapi.json` into `public/openapi.json` so the API reference
page (`/api/reference`) can render it. Regenerate that spec with
`npm run gen:openapi -w @antiphony/core-api` when the API contract changes.
Production builds pass `--strict`, so a missing spec fails the build.

## Structure

```
.
├── public/                         # static assets (+ generated openapi.json)
├── scripts/copy-openapi.mjs        # copies the OpenAPI spec at build time
├── src/
│   ├── assets/
│   ├── content/docs/               # the docs pages (.md / .mdx)
│   └── pages/api/reference.astro   # Scalar endpoint reference (secondary aid)
├── astro.config.mjs                # site config + sidebar
└── package.json
```

Starlight serves every `.md`/`.mdx` under `src/content/docs/` as a route based
on its file path. The canonical contract lives in `src/content/docs/lexicons/` —
the `dev.antiphony.*` lexicon reference is the crown jewel; the Scalar endpoint
page is a generated lookup aid.

## Deploy

Cloudflare Pages builds `npm run build -w @antiphony/docs` and serves
`apps/docs/dist/`. The Scalar bundle is pinned in `reference.astro`; bumping it
is a deliberate review act.
