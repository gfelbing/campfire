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

## Keeping it in sync

Re-vendor when the workspace bumps `moq-net`: download the new crate
(`cargo download` or the crates.io API), replace `src/` and `Cargo.toml`, and
re-apply the patch above (or drop it if the new version already carries it).
Check `CHANGELOG.md` of the new version for other fixes while you are there.
