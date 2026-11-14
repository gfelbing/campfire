# Campfire task runner. Run `just` for help, `just <task>` to run a task.
set positional-arguments

default: help

help:
	@just --list

fmt:
	cargo fmt --all

lint:
	cargo clippy --workspace --all-targets -- -D warnings

test:
	cargo test --workspace

check: fmt lint test
	@echo "all checks passed"

# --- CI gates (the GitHub workflows run exactly one of these each) -----------

# The format gate: checks instead of writing (a plain `cargo fmt` would
# modify files and never fail).
fmt-check:
	cargo fmt --all --check

# Rust gate: format, then lint and tests.
ci-rust: fmt-check lint test

# Client gate: deps, eslint, vitest, then tsc + vite build.
ci-client:
	cd client && npm ci
	cd client && npm run lint
	cd client && npm run test
	cd client && npm run build

# Headless e2e gate: build the client with its e2e debug hooks (C14) and
# the release server that embeds it, mint dev certs, start the server and
# run the browser suite against it. Installs a Chrome when the runner has
# none (the dev loop uses Brave; here the first Chrome/Chromium wins).
ci-e2e: certs
	#!/usr/bin/env bash
	set -euxo pipefail
	BROWSER="$(command -v google-chrome-stable \
	  || command -v google-chrome \
	  || command -v chromium \
	  || command -v chromium-browser || true)"
	if [ -z "$BROWSER" ]; then
	  curl -sSLo /tmp/chrome.deb \
	    https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
	  sudo apt-get install -y /tmp/chrome.deb
	  BROWSER="$(command -v google-chrome-stable)"
	fi
	npm --prefix client ci
	npm --prefix client run build:e2e
	cargo build --release -p campfire-server
	npm --prefix tools/e2e ci
	./target/release/campfire --listen "[::]:8443" \
	  --cert certs/cert.pem --key certs/key.pem > server.log 2>&1 &
	SERVER_PID=$!
	trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
	for i in $(seq 1 30); do
	  if curl -sk -o /dev/null https://localhost:8443/healthz; then break; fi
	  if [ "$i" -eq 30 ]; then
	    echo "server did not come up:"
	    cat server.log
	    exit 1
	  fi
	  sleep 1
	done
	node tools/e2e/e2e.js --browser "$BROWSER"

# --- web client (Phase 4) ---------------------------------------------------

# Install client deps + build into client/dist (embedded into the binary).
client-build:
	cd client && npm ci
	cd client && npm run build

# Dev loop (docs/arch/client.md): vite rebuilds the client on change; the server serves
# client/dist from disk via --static-dir, so the server does not recompile.
# Ctrl-C stops both.
dev *args: certs
	sh -c 'cd client && npx vite build --watch & \
	  vite_pid=$!; trap "kill $vite_pid" EXIT; \
	  cargo run -p campfire-server -- \
	    --listen "[::]:8443" --cert certs/cert.pem --key certs/key.pem \
	    --static-dir client/dist {{args}}'

build: client-build
	cargo build --workspace --release

# Docker image build. Dockerfile uses cache mounts (cargo registry/target,
# npm download cache), so repeat builds only recompile what changed.
# Same target as the CI push (docker.yml, ghcr.io). Extra args pass through:
# just docker -- -t campfire-test
docker *args:
	podman build -t ghcr.io/gfelbing/campfire:latest "$@" .

# Dev certs: a local CA plus a localhost server cert signed by it.
#
# The CA must be trusted by the browser (`just trust`) so the TCP bootstrap
# page loads without an interstitial. Note this alone does NOT unlock HTTP/3:
# Chromium never trusts user-installed CAs for QUIC (built-in roots only),
# so `just brave` pins the cert's SPKI for the dev loop. Production uses a
# publicly-trusted certificate (docs/ops/README.md), which needs neither.
certs:
	mkdir -p certs
	test -f certs/ca.pem -a -f certs/ca-key.pem || \
	  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
	    -sha256 -days 3650 -nodes -keyout certs/ca-key.pem -out certs/ca.pem \
	    -subj "/CN=campfire-dev-ca" \
	    -addext "basicConstraints=critical,CA:TRUE" \
	    -addext "keyUsage=critical,keyCertSign,cRLSign"
	if [ ! -f certs/cert.pem -o ! -f certs/key.pem ]; then \
	  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
	    -sha256 -nodes -keyout certs/key.pem -out certs/req.csr \
	    -subj "/CN=localhost" && \
	  printf "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n" > certs/san.ext && \
	  openssl x509 -req -in certs/req.csr -CA certs/ca.pem \
	    -CAkey certs/ca-key.pem -CAcreateserial -days 3650 -sha256 \
	    -extfile certs/san.ext -out certs/cert.pem; fi
	@echo "dev certs ready in certs/"

# The cert's SPKI sha-256 (base64) — what --ignore-certificate-errors-spki-list wants.
spki: certs
	@openssl x509 -pubkey -noout -in certs/cert.pem \
	  | openssl pkey -pubin -outform der \
	  | openssl dgst -sha256 -binary | openssl enc -base64

# Launch Brave speaking HTTP/3 to the server. Chromium trusts only its
# built-in roots for QUIC — a user-installed CA (just trust) is accepted for
# TCP but always fails the QUIC handshake with CERTIFICATE_VERIFY_FAILED —
# so the dev cert is pinned by SPKI instead. Quit Brave fully first: flags
# are ignored if an instance is already running. The port defaults to the
# dev server's 8443; `just brave 443` targets a Docker server published on
# the default HTTPS port (`just docker`, `docker run -p 443:443 ...`).
# Extra args pass through: just brave 443 --incognito
#
# IPv4 on purpose: Chrome prefers ::1 for `localhost`, and rootless podman's
# pasta network stack does not forward IPv6 UDP to the container (TCP only),
# so QUIC to [::1] dies with ERR_QUIC_PROTOCOL_ERROR while 127.0.0.1 works.
# The SPKI pin is hostname-independent, so 127.0.0.1 needs nothing extra.
brave port="8443" *args: spki
	brave --origin-to-force-quic-on=127.0.0.1:{{port}} \
	  --ignore-certificate-errors-spki-list="$(just spki)" \
	  "https://127.0.0.1:{{port}}/" {{args}}

# Install the dev CA into the NSS trust store Brave/Chrome/Chromium use
# (~/.pki/nssdb). This removes the TCP interstitial; it does NOT enable
# HTTP/3 (see `brave`). Firefox keeps its own store; import there via
# Settings → Privacy → Certificates → View Certificates → Authorities.
trust: certs
	certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "campfire-dev-ca" -i certs/ca.pem
	@echo "campfire-dev-ca trusted for Brave/Chrome/Chromium — restart the browser fully"

# Run the server (dev defaults; extra args pass through: just server -- --idle-timeout-secs 60)
server *args:
	cargo run -p campfire-server --release -- \
	  --listen "[::]:8443" --cert certs/cert.pem --key certs/key.pem "$@"

# Quick HTTP/3 sanity check against a running server.
h3:
	curl --http3 -sk https://127.0.0.1:8443/healthz

# Load harness (docs/dev/testing.md): needs a running server.
loadtest *args:
	cargo run -p campfire-loadtest --release -- \
	  --url https://127.0.0.1:8443/wt "$@"

# E2E server build (C14): the client is built with its e2e debug hooks
# (`build:e2e`, `CAMPFIRE_DEBUG=1`) and the server embeds client/dist, so a
# server serving `just e2e` / `just moq-e2e` must be built this way.
e2e-build:
	cd client && npm run build:e2e
	cargo build --workspace --release

# Headless browser E2E (docs/dev/testing.md): needs a running server built
# with `just e2e-build` and one-time `npm i` in tools/e2e.
e2e *args:
	node tools/e2e/e2e.js --browser "$(command -v brave || command -v chromium || echo chromium)" "$@"

# MoQ uplink E2E (docs/arch/moq-sfu.md): two real browser clients
# publish their media to the SFU and subscribe to each other. Needs a
# running server built with `just e2e-build` and one-time `npm i` in
# tools/e2e.
moq-e2e *args:
	node tools/e2e/moq.js --browser "$(command -v brave || command -v chromium || echo chromium)" "$@"

# MoQ soak (issues.md issue 8.6): the full MoQ e2e plus a hold of N minutes
# (default 30, pass one to override) in which both clients keep their call
# live; asserts continuous delivery, a stable origin gauge, no panics and a
# bounded server RSS. Needs the server built with `just e2e-build`; for the
# server-side assertions, start it with its log at /tmp/campfire-server.log.
soak minutes="30":
	E2E_SOAK_MIN={{minutes}} \
	  E2E_SERVER_LOG=/tmp/campfire-server.log \
	  E2E_SERVER_PID="$(pgrep -o -f 'target/release/campfir[e]' || true)" \
	  node tools/e2e/moq.js --browser "$(command -v brave || command -v chromium || echo chromium)"
