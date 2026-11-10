#!/usr/bin/env bash
# Tier-1 spike matrix (docs/moq-sfu.md Phase 0): fan-out scale and
# fast-start on the host, loss/jitter in a private user+network namespace
# (unshare -rn, host lo untouched), and a 10-minute fan-out soak that
# samples the server's RSS. Emits one JSON per scenario into the output
# dir, consumed by gen_report.py.
#
# Usage: matrix.sh <output-dir>
#   SOAK_DUR=0            skip the (long) soak for fast iteration
#   BASE_DUR / LOSS_DUR   override the per-scenario windows
set -euo pipefail

OUT=${1:?usage: matrix.sh <output-dir>}
REPO=$(cd "$(dirname "$0")/../../" && pwd)
BIN="$REPO/target/release"
HOST=127.0.0.1
PORT=4443
BASE_DUR=${BASE_DUR:-10s}
LOSS_DUR=${LOSS_DUR:-30s}
SOAK_DUR=${SOAK_DUR:-600s}

# 100 ms mean one-way delay with +/-30 ms jitter (T4/T5 "100 ms jitter"),
# applied to every packet egressing lo inside the netns (both directions).
JITTER="delay 100ms 30ms distribution normal"

# Reordering budget (Subscriber Max Age). A zero budget skips a group the
# instant a newer one arrives and drops scattered groups under jitter, so
# every run sets a finite one (client default is 1 s).
MAX_AGE=${MAX_AGE:-1s}

mkdir -p "$OUT"
cd "$REPO"

# VmRSS of a PID in kB (0 if gone).
rss_kb() { awk '/^VmRSS:/{print $2}' "/proc/$1/status" 2>/dev/null || echo 0; }

run_host() { # name subscribers [join_delay]
  local name=$1 subs=$2 jd=${3:-0ms}
  echo "-- $name (subscribers=$subs, join_delay=$jd, $BASE_DUR)"
  "$BIN/moq-spike-client" --url "https://$HOST:$PORT/moq" \
    --path "call/spike/$name" \
    --subscribers "$subs" --duration "$BASE_DUR" --join-delay "$jd" \
    --max-age "$MAX_AGE" \
    >"$OUT/$name.json" 2>"$OUT/$name.err"
}

echo "== host: fan-out + fast-start (single server, sequential runs) =="
"$BIN/moq-spike-server" --listen "$HOST:$PORT" >"$OUT/server-host.log" 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT
sleep 1

run_host fanout-1 1
run_host fanout-4 4
run_host fanout-16 16
# Fast-start (T3/T7): subscribers join a publisher that has been streaming.
run_host faststart-2s 3 2s

if [ "$SOAK_DUR" != "0" ] && [ "$SOAK_DUR" != "0s" ]; then
  echo "-- soak (subscribers=3, $SOAK_DUR, RSS sampled every 30 s)"
  local_rss_before=$(rss_kb "$SRV")
  soak_secs=${SOAK_DUR%s}
  # A before/after pair cannot tell a one-time buffer fill from a leak
  # (T6), so the sampler records RSS throughout the soak.
  (
    samples=()
    t=0
    while [ "$t" -lt "$soak_secs" ]; do
      sleep 30
      t=$((t + 30))
      kb=$(rss_kb "$SRV" || true)
      [ -z "$kb" ] && break
      samples+=("[$t, $kb]")
    done
    [ "${#samples[@]}" -gt 0 ] || samples=("[$soak_secs, 0]")
    printf '{"rss_before_kb": %s, "samples": [%s]}\n' \
      "$local_rss_before" "$(IFS=,; echo "${samples[*]}")" >"$OUT/soak-rss.json"
  ) &
  RSS_JOB=$!
  # The soak reuses the running server; a fresh server would be cleaner but
  # the connection count is what matters for the leak check.
  "$BIN/moq-spike-client" --url "https://$HOST:$PORT/moq" \
    --subscribers 3 --duration "$SOAK_DUR" --max-age "$MAX_AGE" \
    >"$OUT/soak.json" 2>"$OUT/soak.err"
  local_rss_after=$(rss_kb "$SRV")
  wait "$RSS_JOB"
  python3 -c '
import json, sys
path, after = sys.argv[1], int(sys.argv[2])
with open(path) as f:
    d = json.load(f)
d["rss_after_kb"] = after
with open(path, "w") as f:
    json.dump(d, f)
' "$OUT/soak-rss.json" "$local_rss_after"
fi

kill "$SRV" 2>/dev/null || true
wait "$SRV" 2>/dev/null || true
trap - EXIT

run_netem() { # name netem-spec duration
  local name=$1 spec=$2 dur=$3
  echo "-- $name (netem: $spec, $dur, in private netns)"
  OUT=$OUT BIN=$BIN REPO=$REPO HOST=$HOST PORT=$PORT NAME=$name SPEC=$spec DUR=$dur MAX_AGE=$MAX_AGE \
    unshare -rn bash -c '
      # No set -e: we want the client exit code even on failure. But netem
      # setup must be explicit: a silent no-loss run would corrupt T4/T5.
      set -u
      ip link set lo up || { echo "lo up failed" >&2; exit 78; }
      # Unquoted on purpose: $SPEC word-splits into separate netem options.
      tc qdisc add dev lo root netem $SPEC \
        || { echo "netem setup failed: $SPEC" >&2; exit 77; }
      cd "$REPO"
      "$BIN/moq-spike-server" --listen "$HOST:$PORT" >"$OUT/$NAME-server.log" 2>&1 &
      SRV=$!
      sleep 1
      "$BIN/moq-spike-client" --url "https://$HOST:$PORT/moq" \
        --subscribers 1 --duration "$DUR" --max-age "$MAX_AGE" \
        >"$OUT/$NAME.json" 2>"$OUT/$NAME.err"
      rc=$?
      kill "$SRV" 2>/dev/null || true
      wait "$SRV" 2>/dev/null || true
      exit "$rc"
    '
}

echo "== netns: loss/jitter matrix (server+client per scenario) =="
run_netem loss0-jitter100 "$JITTER" "$LOSS_DUR"
run_netem loss5-jitter100 "loss random 5% $JITTER" "$LOSS_DUR"
run_netem loss20-jitter100 "loss random 20% $JITTER" "$LOSS_DUR"

echo "== matrix done: $OUT =="
ls -1 "$OUT"/*.json
