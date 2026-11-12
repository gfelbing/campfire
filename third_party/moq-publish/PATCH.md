# @moq/publish churn patch

Campfire patches the installed `@moq/publish` bundle so the video encoder's
catalog stays **stable**: the `stalled` field is pinned to `false` instead of
the stall detector's live flag. This is a companion to the
`@moq/watch` catch-up patch (`../moq-watch/PATCH.md`); like that one it is a
`postinstall` re-apply, not a vendored copy.

## Why

The stock video encoder writes `stalled: <detector flag>` into its track
catalog on every detector observation — up to 50 observations per second
while the OpenH264 encode queue flaps under CPU load (measured in headless
e2e). In moq-lite a catalog change **re-announces the hang**, the SFU
re-routes, and every subscriber flips to a new track identity — each
generation rebuilding its `VideoEncoder` (an OpenH264 reinit storm). The
observable damage: decoder churn that replays retained history (a one-shot
burst of ~10 frames at every catalog flip, e2e step 8) and, under load,
downlink gaps large enough to feed the audio flatline the `@moq/watch`
main-bundle patch now defends against.

The campfire client never reads the `stalled` catalog field (grep-verified:
no reference in `client/src`), so pinning it is safe: the detector keeps
running internally, but the published catalog content is constant, so no
re-announce churn.

## The patch

`patch.mjs` replaces exactly two occurrences of

```js
stalled: this.#l.flag()
```

in the version-hashed encoder chunk (`client/node_modules/@moq/publish/encoder-*.js`)
with

```js
stalled: !1 // [campfire publish patch]
```

and is idempotent (mixed patched/stock state is an error, as is any
occurrence count other than 2 on a fresh bundle). Wired into the client's
`postinstall` next to the `@moq/watch` patcher, so a fresh `npm ci`
restores the stock bundle and re-patches it:

```
client/package.json  →  "postinstall": "node ../third_party/moq-watch/patch.mjs && node ../third_party/moq-publish/patch.mjs"
```

## Verifying

```
node third_party/moq-publish/patch.mjs
# fresh bundle:  @moq/publish patch: 2 sites patched
# re-run:        @moq/publish patch: already present (2 sites)
grep -c "campfire publish patch" client/node_modules/@moq/publish/encoder-*.js
# → 2
```

Behavior check: run the MoQ e2e (`just moq-e2e`) with a CPU-loaded encoder;
the downlink frame counter must not show step bursts at catalog flips
(e2e step 8 allows the bounded 300 ms playback-delay tail and then requires
the plateau).
