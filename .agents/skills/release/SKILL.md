---
name: release
description: >
  Cut a campfire release. Takes the version as an argument (e.g. /release
  0.0.13): verifies CI, bumps every version file, writes the changelog
  entry, commits, tags and pushes (the tag triggers the Docker/GHCR build).
  Use for "release", "cut a release", "bump version", /release.
---

Cut a release of this repository. The version argument is required: a
plain semver like `0.0.13`, without the leading `v`. If the user did not
give one, ask — never guess or derive it.

## Overview

The flow, in order:

1. Verify the tree is releasable (on `main`, up to date, CI green).
2. Bump the version in every file that carries it.
3. Write the `CHANGELOG.md` entry for the new version.
4. Commit as `release: <version>`, tag `v<version>`, push both.
5. Confirm the Docker workflow picked the tag up.

Pushing the tag triggers `docker.yml` (image to GHCR, Helm chart to
GHCR OCI). Do not push until the user has seen the changelog entry.

## 1. Verify CI

- The release is cut from `main`: `git switch main`,
  `git pull --ff-only origin main`. Refuse (ask) if the working tree
  is dirty or on another branch with unpushed work.
- Run the local gate exactly as CI runs it: `just ci`. This is the
  same target `.github/workflows/check.yml` runs on main, so a local
  pass means main's check run is consistent with the tree.
- If `gh` is installed, additionally confirm the latest `check` run on
  `main` succeeded (`gh run list --workflow=check --limit 1`); if it
  failed after the last push, stop and report.
- If `just ci` fails: fix or report — do not release from a red tree.

## 2. Bump versions

The version lives in exactly these places (see `git show --stat` of a
previous `release:` commit, e.g. `21a7fca`):

- `Cargo.toml` — `[workspace.package]` `version = "X.Y.Z"` (single
  source for all workspace members; member crates inherit it, do not
  touch their Cargo.tomls).
- `Cargo.lock` — regenerated: run `cargo update -w` (updates the
  workspace member versions in the lock; never hand-edit the lock).
- `client/package.json` — top-level `"version"`.
- `client/package-lock.json` — both the root `"version"` and
  `packages[""].version`; regenerate with `npm --prefix client install
  --package-lock-only` instead of hand-editing.
- `deploy/helm/campfire/Chart.yaml` — `version:` and `appVersion:`
  (the appVersion is the default image tag, keep both in sync).

Bump all of them, then verify nothing else still holds the old
version:

```
grep -rn "$(cat Cargo.toml old version)" --exclude-dir=target \
  --exclude-dir=node_modules --exclude-dir=third_party .
```

(search for the old version string and expect only the changelog's
old entry to remain).

## 3. Changelog

`CHANGELOG.md`, newest entry directly under the intro paragraph:

```
## [X.Y.Z] — YYYY-MM-DD

### Added
### Changed
### Fixed
```

- Use only the sections that have content (Added/Changed/Fixed is the
  established set; match previous entries).
- Source material: `git log v<prev>..HEAD` plus the diff. Summarize
  by feature, not per commit. Merge fixups (`chore: drop the stray
  screenshot`) into the feature they fixed.
- House style: each entry opens with a one-paragraph nickname theme
  ("The avatar release: ..."), items are full sentences explaining
  behavior and why, referencing mechanics by name (wire field, config
  flag) where it helps. Read the two entries above yours before
  writing.

## 4. Commit, tag, push

- Stage exactly the six release files (CHANGELOG.md, Cargo.toml,
  Cargo.lock, client/package.json, client/package-lock.json,
  deploy/helm/campfire/Chart.yaml) plus nothing else that happened to
  be dirty — check `git status` first and stop if unrelated changes
  are staged/modified.
- Commit message: `release: X.Y.Z` (no `v`, no type prefix — matches
  history).
- Tag: `vX.Y.Z` on that commit, annotated
  (`git tag -a vX.Y.Z -m "campfire X.Y.Z"`).
- Show the user the changelog entry and the commit; after approval:
  `git push origin main && git push origin vX.Y.Z`.

## 5. Confirm

- `git ls-remote origin refs/tags/vX.Y.Z` shows the tag.
- The `docker` workflow builds on the tag; watch it if `gh` is
  available (`gh run list --workflow=docker`) and report the outcome.
  Image tags land as `ghcr.io/gfelbing/campfire:X.Y.Z`, `:X.Y`, and
  `:latest`; the Helm chart is pushed as OCI to
  `ghcr.io/gfelbing/helm`.

## Edge cases

- Version argument malformed (not `X.Y.Z`): ask, do not coerce.
- Tag already exists: stop, report — never re-tag or force-push.
- `docker.yml` on a tag has no CI gate before the push: that is why
  `just ci` must pass before the tag is created.
- Pre-release or post-release fixes keep the same flow; version is
  always the user's argument, changelog date is today's.
