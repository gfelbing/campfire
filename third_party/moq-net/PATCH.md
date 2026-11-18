# Vendored moq-net 0.3.23, patched

This is a copy of the [`moq-net`](https://github.com/moq-dev/moq) crate,
version 0.3.23 (2026-11-11), vendored so the SFU can depend on a local patch
via `[patch.crates-io]` in the workspace root `Cargo.toml`. It is not a
workspace member: it is built as an ordinary dependency, only its source lives
in this repository.

## The patch

`src/lite/publisher.rs`, `AnnounceRun::init`, the `Lite01 | Lite02` branch:

the initial `ANNOUNCE_INIT` burst is now registered in `AnnounceRun.live`, the
map of routes the peer currently holds.

Without it, the burst never enters `live`, so:

- a later retraction of a burst route is silently dropped (`retract` finds
  nothing to end), and
- a re-announce of the same route sends a second `Active` with no preceding
  `Ended`, which the `@moq/net` subscriber treats as a protocol violation and
  closes the session (close code 15, reason `duplicate announce for <path>`).

That is what killed the second participant's session whenever a first
participant's tab reloaded and re-announced the same hang path. Upstream fixed
the same defect after 0.3.23; this change mirrors that fix.

A second, cosmetic change: `src/model/frame.rs` uses the renamed
`AtomicUsize::try_update` (the 0.3.23 source calls the deprecated alias
`fetch_update`, which the pinned Rust 1.99.1 warns about).

See the end of this file for the campfire `serving_max_age` deviation.

## Keeping it in sync

Re-vendor when the workspace bumps `moq-net`: download the new crate
(`cargo download` or the crates.io API), replace `src/` and `Cargo.toml`, and
re-apply the patch above (or drop it if the new version already carries it).
Check `CHANGELOG.md` of the new version for other fixes while you are there.

## Campfire deviation: serving_max_age for pre-06 wires

Upstream (0.3.23, `src/lite/publisher.rs`): for Lite01/02 — which cannot
carry a subscriber max-age on the wire — `serving_max_age` returns
`MAX_SAFE_AGE_MS` (unbounded), so nothing is ever skipped under legacy
peers. Campfire serves only its own lite-02 clients, and for live calls
that budget is actively harmful: the publisher's held batches arrive
after the live edge (newest-first serving), the subscriber-side skip is
the only protection, and the startup delay spikes with it
(docs/dev/latency-optimization.md §10.3).

The deviation honors `requested` for every wire (both match arms return
it). For a decoded Lite01/02 SUBSCRIBE that is ZERO — i.e. hold legacy
peers to the live edge, skipping non-latest groups older than nothing.
The catalog track is single-group-per-update and the fetch/replay paths
are unaffected (they carry explicit bounds). Re-vendor on a bump and
re-apply or drop if upstream changes the semantics.

## Freshness (2026-11-18)

0.3.23 is still the newest crates.io release. Upstream main has diverged
heavily since (the lite-07 wire, the auth rework, the `moq-tokio` API
changes) but none of it is published; moving to it means rewriting the
SFU integration against a new API. The fork stays at 0.3.23 + the
announce-init patch above until a release line carries a reason to move.
