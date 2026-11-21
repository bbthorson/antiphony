# Antiphony audio-rendition service.
#
# The one Antiphony deployable that is a container rather than a Worker, because
# it spawns `ffmpeg` and no Workers runtime can spawn a subprocess. See
# specs/archive/cloudflare-migration.md § The ffmpeg problem.
#
# Build from the REPO ROOT so the workspace install resolves:
#
#     docker build -f apps/audio-rendition/Dockerfile .

# ── build ─────────────────────────────────────────────────────────────────────
# `-bookworm-slim`, not `-slim`: from Node 26 the bare `-slim` tag is Debian 13
# (trixie), which would also move ffmpeg from 5.1 to 7.1. Node 22's `-slim` was
# bookworm, so pinning the codename keeps ffmpeg where it was. Move to trixie in
# its own change, with renditions compared before and after.
FROM node:26-bookworm-slim AS build

WORKDIR /app

# The npm this repo is verified against. Pinned explicitly rather than resolved,
# for the reason the root package.json records at length: production once built
# on a buildpack's own npm and an unreviewed bump to it broke prod.
RUN npm install --global npm@12.0.2

# Workspace manifests first, so a source-only change reuses the install layer.
COPY package.json package-lock.json ./
COPY apps/audio-rendition/package.json ./apps/audio-rendition/

# `--workspace` alone still installs the whole workspace graph in npm's
# lockfile-driven install, which is what we want here: the lockfile is the root
# one and resolving against a subset would ignore it.
RUN npm ci

COPY apps/audio-rendition ./apps/audio-rendition

RUN npm run build --workspace @antiphony/audio-rendition

# Fail the build rather than ship an artifact that cannot start.
RUN test -s apps/audio-rendition/dist/index.js

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS runtime

# ffmpeg, and the ASSERTION that it landed.
#
# This is the half that actually prevents shipping a broken image. The service
# spawns a bare `ffmpeg` off PATH and nothing in package.json declares one — as
# a Firebase Function that worked only because Google's Node runtime image
# happened to ship the binary, and `node:26-bookworm-slim` does not. Without the assert,
# a failed or renamed package produces an image that builds green, starts green,
# answers /health green, and 502s on the first cache miss — which on this
# workload could be weeks later, and presents as a caller hearing nothing.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg tini \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -version

WORKDIR /app

# The bundle is self-contained — no node_modules in the runtime image at all,
# which is the point of bundling. Everything this service imports at runtime is
# inlined; `ffmpeg` is the one dependency that is not, and it is above.
COPY --from=build /app/apps/audio-rendition/dist ./dist

ENV NODE_ENV=production
EXPOSE 8080

# tini as pid 1 so the default SIGTERM disposition applies and the container
# stops promptly. A process running as pid 1 gets no default signal handling
# from the kernel, so a SIGTERM it has installed no handler for is discarded
# and the platform waits out its grace period before SIGKILL.
#
# There is no graceful drain here, deliberately. A transcode cannot be drained
# in any useful window, and there is nothing to lose by dropping one: the caller
# treats a failure as "no rendition yet" and the work is idempotent, so the next
# request rebuilds it.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
