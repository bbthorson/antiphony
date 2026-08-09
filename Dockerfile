# Container image for apps/core-api, for Cloud Run.
#
# ── Why this exists ───────────────────────────────────────────────────────────
# This replaced the Firebase App Hosting buildpack, which served api.antiphony.dev
# until the Cloud Run cutover. The buildpack was a black box that ran the ROOT
# package.json scripts from /workspace, which is why `start` still lives at the
# root and why `rootDirectory` was unusable. It also picked its own npm,
# independent of this repo's `packageManager` pin — a bump to that npm broke
# production here once. A Dockerfile makes both the toolchain and the entrypoint
# explicit and pinned.
#
# ── Shape ─────────────────────────────────────────────────────────────────────
#   build   — full workspace install, bundles core-api to dist/index.js
#   deps    — production-only install of the four externals dist/ needs at runtime
#   runtime — dist/ + deps' node_modules, nothing else
#
# The split matters because the build needs devDependencies (esbuild, tsx,
# typescript, tsup) that must not ship, and because `npm ci --omit=dev` cannot
# run in the same tree that just built — see the `deps` stage.

ARG NODE_VERSION=22-bookworm-slim

# ──────────────────────────────────────────────────────────────────────────────
# Stage: build
# ──────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS build
WORKDIR /workspace

# npm pinned to the repo's `packageManager`, not whatever the base image ships
# (Node 22 carries npm 10). This repo's root package.json declares `allowScripts`
# precisely so npm 12 still runs the install scripts that are load-bearing —
# ffmpeg-static's binary download above all. Pinning here rather than inheriting
# is the whole point: an unreviewed npm major is how prod broke last time.
RUN npm install -g npm@12.0.2

# Manifests before source, so the install layer survives a source-only change.
# Every workspace's package.json must be present or `npm ci` rejects the
# lockfile as out of sync — including apps/docs and apps/reference, which this
# image never builds.
COPY package.json package-lock.json .npmrc ./
COPY apps/core-api/package.json      apps/core-api/
COPY apps/docs/package.json          apps/docs/
COPY apps/reference/package.json     apps/reference/
COPY packages/core/package.json      packages/core/
COPY packages/shared/package.json    packages/shared/

# Fails without packages/shared's source, because its `prepare` script builds it
# during install. That is intended — `prepare` is load-bearing for the typecheck
# and for every workspace that resolves @antiphony/shared/* into dist/.
COPY packages/shared/ packages/shared/
RUN npm ci

COPY tsconfig.json ./
COPY packages/core/ packages/core/
COPY apps/core-api/ apps/core-api/

# esbuild bakes COMMIT_SHA into the bundle via `define`, so /health can report
# the deployed revision without a runtime env var. App Hosting got this from
# Cloud Build; here the CI workflow passes it as a build arg. Unset means 'dev',
# which is the same default the bundler already applies.
ARG COMMIT_SHA=dev
ENV COMMIT_SHA=${COMMIT_SHA}

# Builds @antiphony/shared (dual ESM/CJS) then bundles core-api and regenerates
# the OpenAPI documents. No network, no secrets.
RUN npm run build

# The bundle is the deployable artifact and nothing downstream typechecks it.
# Assert it exists and is non-trivial rather than discovering an empty dist/ at
# `docker run` time.
RUN test -s apps/core-api/dist/index.js

# ──────────────────────────────────────────────────────────────────────────────
# Stage: deps — production-only tree for the runtime image
# ──────────────────────────────────────────────────────────────────────────────
# esbuild externalizes four packages (see apps/core-api/esbuild.config.mjs):
# firebase-admin, pino, pino-pretty, ffmpeg-static. Everything else — Hono, zod,
# @antiphony/core, @antiphony/shared — is inlined into dist/index.js. So this
# stage exists only to produce node_modules for those four and their transitive
# deps (firebase-admin's grpc/protobufjs tree is most of the weight).
FROM node:${NODE_VERSION} AS deps
WORKDIR /workspace

RUN npm install -g npm@12.0.2

COPY package.json package-lock.json .npmrc ./
COPY apps/core-api/package.json      apps/core-api/
COPY apps/docs/package.json          apps/docs/
COPY apps/reference/package.json     apps/reference/
COPY packages/core/package.json      packages/core/
COPY packages/shared/package.json    packages/shared/

# npm runs a linked workspace's `prepare` even under `--ignore-scripts`, and
# shared's `prepare` shells out to tsup — a devDependency that `--omit=dev` did
# not install. The install dies there. Nothing in the runtime image ever loads
# @antiphony/shared from disk (it is bundled into dist/index.js), so drop the
# script instead of dragging a build toolchain into a production tree.
RUN npm pkg delete scripts.prepare -w @antiphony/shared

# Scoped to core-api so the docs and reference workspaces' runtime dependencies
# — astro, sharp, react — stay out. Verified: with `-w @antiphony/core-api
# --include-workspace-root`, none of the three appear in the resulting tree.
#
# Install scripts run deliberately (no --ignore-scripts). ffmpeg-static resolves
# its binary path at module load whether or not the download happened, so with
# scripts off it hands back a path to a file that does not exist —
# `ffmpegAvailable()` then returns false and the trim and waveform stages settle
# `skipped` on every post, silently. That is the exact failure this repo's
# allowScripts note is about, and it is a wrong answer, not an error.
RUN npm ci --omit=dev -w @antiphony/core-api --include-workspace-root

# Turn that silent-skip failure into a build failure. If ffmpeg-static's download
# was blocked, this is where it stops.
RUN test -x node_modules/ffmpeg-static/ffmpeg \
    && node_modules/ffmpeg-static/ffmpeg -version > /dev/null

# ──────────────────────────────────────────────────────────────────────────────
# Stage: runtime
# ──────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production

# tini keeps node off pid 1, and that is not a stylistic preference — it was
# measured. A process running as pid 1 gets no default signal dispositions from
# the kernel, so a SIGTERM it has installed no handler for is simply discarded:
# `docker stop` on an early build of this image hung for the full grace period
# and then SIGKILLed (exit 137). Adding an init in front made the same image
# exit on the signal immediately (exit 143).
#
# src/lib/shutdown.ts now installs a real handler, so the drain — not tini — is
# what normally ends this process (exit 0, with a `drained, exiting` log line).
# tini stays anyway, and the three exit codes are how you tell which path ran:
#
#   0    the handler drained and exited      — expected
#   143  tini forwarded, default disposition — handler missing or not yet armed
#   137  SIGKILL after the grace period      — nothing handled the signal
#
# That makes tini a backstop rather than redundancy. The handler is installed
# only after `serve()` returns, so a signal arriving during the boot gate — which
# does network I/O and can be slow — still lands on a bare pid 1. Without tini
# that window is a guaranteed 10s hang ending in a kill.
#
# It also matters that this is not a regression the migration invents: under App
# Hosting the buildpack's `npm start` leaves npm at pid 1 and node an ordinary
# child, so SIGTERM did kill it — instantly, mid-request. Draining is new here.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# The `node` user (uid 1000) ships with the base image. Cloud Run does not
# require a non-root container, but nothing here needs root either.
USER node

COPY --from=deps  --chown=node:node /workspace/node_modules ./node_modules
# The source map ships on purpose: the bundle is built unminified precisely so
# stack traces in Cloud Logging point at the original TypeScript.
COPY --from=build --chown=node:node /workspace/apps/core-api/dist/ ./dist/

# Cloud Run injects PORT; src/index.ts falls back to 8080. Declared for
# documentation and for `docker run -P` locally — Cloud Run ignores EXPOSE.
EXPOSE 8080

# Both in exec form, so no shell sits in the process tree swallowing signals.
# tini is pid 1 and forwards SIGTERM to node, which then dies on the default
# disposition — see the long note above for why that indirection is required.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
