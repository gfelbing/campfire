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
	    --listen "[::]:8443" --cert certs/cert.pem --key certs/key.pem \
	    --static-dir client/dist {{args}}'

build: client-build
	cargo build --workspace --release

# Docker image build. Dockerfile uses cache mounts (cargo registry/target,
# npm download cache), so repeat builds only recompile what changed.
# Extra args pass through: just docker -- -t campfire-test
docker *args:
	podman build -t campfire "$@" .

# Dev certs: a local CA plus a localhost server cert signed by it.
#
# The CA must be trusted by the browser (`just trust`) so the TCP bootstrap
# page loads without an interstitial. Note this alone does NOT unlock HTTP/3:
# Chromium never trusts user-installed CAs for QUIC (built-in roots only),
# so `just brave` pins the cert's SPKI for the dev loop. Production uses a
# publicly-trusted certificate (README §15), which needs neither.
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
brave port="443" *args: spki
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

# Load harness (README §11 Phase 9): needs a running server.
loadtest *args:
	cargo run -p campfire-loadtest --release -- \
	  --url https://127.0.0.1:8443/wt "$@"

# Headless browser E2E (README §11 Phase 9): needs a running server and
# one-time `npm i` in tools/e2e.
e2e *args:
	node tools/e2e/e2e.js --browser "$(command -v brave || command -v chromium || echo chromium)" "$@"
