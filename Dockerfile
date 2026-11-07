# Campfire: one static binary, one port (443 UDP + 443 TCP).
#
# Build:  docker build -t campfire .
# Run:    docker run --rm -p 443:443/udp -p 443:443/tcp \
#           -v $PWD/certs:/certs:ro campfire \
#           --listen 0.0.0.0:443 --cert /certs/cert.pem --key /certs/key.pem
#
# QUIC needs UDP 443; the same port number over TCP serves the Alt-Svc
# bootstrap + TURN-over-TLS. UDP is not forwarded by `docker run -p`
# unless you ask for /udp explicitly — hence both.

FROM rust:1-slim AS build
WORKDIR /build
# Client deps first (their lockfile changes rarely): the vite build runs
# in the same stage as cargo so the static embed is fresh.
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY tools/loadtest ./tools/loadtest
COPY client ./client
COPY maps ./maps
COPY justfile ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*
RUN npm --prefix client ci && npm --prefix client run build
RUN cargo build --release

FROM debian:stable-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/campfire /usr/local/bin/campfire
# Certs are mounted at runtime (see README §15): never bake keys into an
# image layer.
EXPOSE 443/udp
EXPOSE 443/tcp
ENTRYPOINT ["campfire"]
