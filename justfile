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

# --- web client (Phase 4) ---------------------------------------------------

# Install client deps + build into client/dist (embedded into the binary).
client-build:
	cd client && npm ci
	cd client && npm run build

# Dev loop (README §8): vite rebuilds the client on change; the server serves
# client/dist from disk via --static-dir, so the server does not recompile.
# Ctrl-C stops both.
dev *args: certs
	sh -c 'cd client && npx vite build --watch & \
	  vite_pid=$!; trap "kill $vite_pid" EXIT; \
	  cargo run -p campfire-server -- \
	    --listen 127.0.0.1:8443 --cert certs/cert.pem --key certs/key.pem \
	    --static-dir client/dist {{args}}'

build: client-build
	cargo build --workspace --release

# Self-signed dev certs for localhost (browser needs a one-time exception).
certs:
	mkdir -p certs
	test -f certs/cert.pem -a -f certs/key.pem || \
	  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
	    -sha256 -days 90 -nodes -keyout certs/key.pem -out certs/cert.pem \
	    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
	@echo "dev certs ready in certs/"

# Run the server (dev defaults; extra args pass through: just server -- --listen 0.0.0.0:443)
server *args:
	cargo run -p campfire-server --release -- \
	  --listen 127.0.0.1:8443 --cert certs/cert.pem --key certs/key.pem "$@"

# Quick HTTP/3 sanity check against a running server.
h3:
	curl --http3 -sk https://127.0.0.1:8443/healthz
