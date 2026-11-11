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

FROM rust:1-slim AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Client deps first (their lockfile changes rarely): the vite build runs
# in the same stage as cargo so the static embed is fresh.
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
# The tools are workspace members: cargo loads every member's manifest
# before building, so their sources must be present even though only the
# server is compiled.
COPY tools/loadtest ./tools/loadtest
COPY tools/moq-spike ./tools/moq-spike
COPY client ./client
COPY maps ./maps
COPY justfile ./
# BuildKit-style cache mounts (docker ≥ 19.03 with BuildKit, podman ≥ 2.0):
# the npm download cache, the cargo registry/git caches and the target dir
# survive between builds, so repeat builds only recompile what changed.
# Cached paths are NOT part of the image — hence the cp of the binary out
# of the target cache in the same RUN.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm --prefix client ci && npm --prefix client run build
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
