# Campfire: one static binary, one port (443 UDP + 443 TCP).
#
# Build:  just docker          (recommended: keeps cargo + npm caches)
# or:     docker build -t campfire .
# Run:    docker run --rm -p 443:443/udp -p 443:443/tcp \
#           -v $PWD/certs:/certs:ro campfire \
#           --listen 0.0.0.0:443 --cert /certs/cert.pem --key /certs/key.pem \
#           --external <your-LAN-IP>:443
#
# QUIC needs UDP 443; the same port number over TCP serves the Alt-Svc
# bootstrap. UDP is not forwarded by `docker run -p` unless you ask for
# /udp explicitly — hence both.

# Pinned to rust-toolchain.toml (the rust:* images honor it via rustup, but
# a valid base tag is a hard requirement — `rust:1-slim` does not exist).
FROM rust:1.99.1-slim AS build
# Node 22 LTS from NodeSource (matches CI's node-version): the Debian apt
# node (20.x) is below vitest's engine requirement and npm warns EBADENGINE
# for the whole install.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Client deps first (their lockfile changes rarely): the vite build runs
# in the same stage as cargo so the static embed is fresh.
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
# The tools are workspace members: cargo loads every member's manifest
# before building, so their sources must be present even though only the
# server is compiled. third_party/moq-net and third_party/h3-quinn are not
# members but the [patch.crates-io] paths in Cargo.toml must exist for
# cargo to load. The moq-watch/moq-publish patch scripts run from the
# client's postinstall after `npm ci`.
COPY tools/loadtest ./tools/loadtest
COPY third_party/moq-net ./third_party/moq-net
COPY third_party/h3-quinn ./third_party/h3-quinn
COPY third_party/moq-watch ./third_party/moq-watch
COPY third_party/moq-publish ./third_party/moq-publish
COPY client ./client
COPY maps ./maps
# BuildKit-style cache mounts (docker ≥ 19.03 with BuildKit, podman ≥ 2.0):
# the npm download cache, the cargo registry/git caches and the target dir
# survive between builds, so repeat builds only recompile what changed.
# Cached paths are NOT part of the image — hence the cp of the binary out
# of the target cache in the same RUN.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm --prefix client ci --no-audit --no-fund && npm --prefix client run build
# Only the server package is shipped; -p skips compiling the tools'
# binaries (their sources must still exist — cargo loads every workspace
# member's manifest before building anything).
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/build/target,sharing=locked \
    cargo build --release -p campfire-server && cp target/release/campfire /build/campfire

FROM debian:stable-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/campfire /usr/local/bin/campfire
# Certs are mounted at runtime (see README §15): never bake keys into an
# image layer.
EXPOSE 443/udp
EXPOSE 443/tcp
ENTRYPOINT ["campfire"]
