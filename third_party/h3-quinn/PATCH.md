# Vendored h3-quinn 0.0.10, patched

This is a copy of the [`h3-quinn`](https://github.com/hyperium/h3) crate,
version 0.0.10 (the latest release of the 0.0.x line; h3 0.0.8's transport
pair), vendored so the server can depend on a local patch via
`[patch.crates-io]` in the workspace root `Cargo.toml`. It is not a
workspace member: it is built as an ordinary dependency, only its source
lives in this repository.

## The patch

`src/lib.rs`, `struct RecvStream` and its `quic::RecvStream` impl:

- `stop_sending` no longer `unwrap`s on `self.stream`. `poll_data` moves the
  stream out of the `Option` for the duration of an in-flight `read_chunk`;
  if h3 calls `stop_sending` on the same stream meanwhile — which is exactly
  what connection teardown does (timeout, peer reset) — the `Option` is
  `None` and the old code panicked. The panic killed the tokio task driving
  that QUIC connection mid-teardown, so the MoQ session's own cleanup
  (drop, metrics, `quic.close`) was skipped. The fix skips the `stop` when
  the stream is in flight: the in-flight read returns the reset state on
  its own, so the receiver still observes the termination.
- `recv_id` no longer reaches through the `Option` either. The stream id is
  cached in a new `id` field at construction, so a call during the in-flight
  window can no longer panic.

Two-line behavioral change (one guard, one cached field); everything else
is untouched.

Upstream context: the same `unwrap` exists in h3-quinn 0.0.10, which is the
last 0.0.x release; there is no upgrade that fixes it. If a future h3/h3-
quinn line lands with the fix, re-vendor and drop this patch.

## Keeping it in sync

Re-vendor when the workspace bumps h3/h3-quinn: download the new crate
(`cargo download` or the crates.io API), replace `src/` and `Cargo.toml`,
and re-apply the patch above (or drop it if the new version already carries
it).
