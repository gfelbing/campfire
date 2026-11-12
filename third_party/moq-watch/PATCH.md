# @moq/watch catch-up patch

Campfire patches the installed `@moq/watch` bundle so audio **catches up by
playing faster** when it falls behind the live edge, instead of skipping.
This is the client half of the "skipping when falling behind the video
stream" work in `issues.md` (the other half is the driven
`Sync.in.delay` / `Sync.in.buffer` signals in `client/src/call/moq.ts`).

## Why a patch, not a config

The audio ring buffers in `@moq/watch` have no "play faster" mode:

- `SharedRingBuffer.read()` (the SharedArrayBuffer worklet path) *skips*
  the backlog in non-buffered mode (`read = write - latency`), dropping
  audio at read time.
- `AudioRingBuffer.read()` (the postMessage fallback — the path actually
  used without `crossOriginIsolated`) has no skip at all; a backlog there
  means permanent drift.

Buffered mode (set by `Sync.in.buffer > 0`) removes the first skip and
grows the transport `maxAge`, so the backlog reaches the ring. But neither
reader then consumes it faster than real time, so the delay floor keeps
climbing. The patch adds the time-compression read to both.

## Mechanism

The audio worklet (both ring classes) is not a separate file: it is an
embedded **Blob string literal** inside the version-hashed player chunk
(`client/node_modules/@moq/watch/player-*.js`):

```js
xe = new Blob(["<worklet source>"], { type: "application/javascript" })
```

`patch.mjs` therefore:

1. finds that literal by content (the chunk filename is version-hashed —
   `player-B6mw85kT.js` today — so it is never matched by name; the
   `new Blob(["…"], { type: "application/javascript" })` anchor is the
   stable part, and it is the only such literal in the chunk),
2. decodes the literal (it is a JS string with raw tabs, not JSON — raw
   control characters are escaped before `JSON.parse`),
3. applies the replacements below to the *unescaped* worklet source —
   each must match the stock code exactly once, and is skipped when its
   patched form is already present,
4. writes the literal back (re-serialized via `JSON.stringify`, so the
   worklet source is byte-identical either way).

It is wired as the client's `postinstall` script, so a fresh `npm ci`
(which restores the stock bundle) re-patches automatically:

```
client/package.json  →  "postinstall": "node ../third_party/moq-watch/patch.mjs && node ../third_party/moq-publish/patch.mjs"
```

Re-run manually after any `@moq/watch` version bump:

```
node third_party/moq-watch/patch.mjs
```

Expected output on a fresh install (postinstall): `worklet 9 applied,
0 already present; main 1 applied, 0 already present`. Re-running on an
already-patched bundle: `worklet 0 applied, 9 already present; main 0
applied, 1 already present` (idempotency check). If a replacement finds
zero or >1 stock occurrences the script dies without writing — the bundle
layout changed, update the snippets.

## The 9 edits

All marked `// [campfire catch-up]` in the worklet.

**`AudioRingBuffer` (postMessage path):**

1. new field `#readPosF` — fractional read cursor. An integer cursor
   cannot advance a fractional number of samples per output sample while
   draining a backlog.
2. `write()`: anchor `#readPosF = start` on first write.
3. `write()`: overflow (writer outpaces the reader) advances `#readPosF`
   alongside `#readIndex`.
4. `#reallocate()`: on a resize the cursor follows the new `#readIndex`
   (the resize keeps the newest samples).
5. `reset()`: cursor cleared.
6. `read()`: **the speed-up.** While `ahead = write − readPosF` exceeds
   the latency floor, consume `rate = min(1 + excess/latency, 2.5)`
   source samples per output sample, linearly interpolated on the
   fractional cursor; below the floor this is exactly the stock 1:1 copy.
   If the backlog is smaller than one output quantum the rate is capped
   at `ahead/outLen` — it stretches the tail instead of gapping. After
   the loop `#readIndex = floor(#readPosF)` (the write path keeps integer
   semantics).

**`SharedRingBuffer` (SharedArrayBuffer worklet path):**

7. new fields `#readPosF` (fractional cursor) and `#lastTimeline` — a
   writer re-anchor (new track) resets the playhead to a fresh timeline,
   which invalidates an older cursor.
8. constructor: seed the cursor from the shared read position and record
   the current timeline.
9. `read()`: **the speed-up, minus the skip.** Timeline change → resync
   the cursor; a playhead published above the cursor (writer overflow) →
   sync up, never down. Then the same `rate`/interpolation math as edit
   6, with the published cursor CAS'd (`compareExchange`) as
   `floor(readPosF + consume)` and the output zero-filled on a race loss,
   exactly like the stock publish path. The stock non-buffered skip is
   gone: there is no `read = write - latency` branch anymore.

## The main-bundle edit (10th)

The worklet edits make the ring *able* to drain a backlog fast. A second
failure mode sat on the decoder side: the pacing wait.

**The flatline.** The audio decode loop paces each frame with
`ring.wait(frameTs)` — "wait until the playhead reaches this frame's
timestamp minus headroom". If the container consumer skipped ahead by
more than the headroom (a gap in the media timeline — observed when the
screen-share re-route re-announced the broadcast and the consumer jumped
~0.9 s), the ring drains, the playhead can never catch up to the waiting
frame, and the wait blocks **forever**: the decode loop is frozen, no
frames are inserted, the ring starves, and audio flatlines while video
keeps rendering (e2e step 7 caught it: audio bytes frozen during a
share).

**The patch** (in the player chunk itself, not the worklet — the wait
lives in the decoder's insert path, marked `// [campfire catch-up]`):
race `ring.wait(frameTs)` against a 2000 ms grace. On expiry, if the
ring playhead is still more than a second behind the waiting frame, call
`ring.reset()`: the ring clears its cursors and un-anchors, so the next
insert re-anchors the playhead at the new frame's timestamp and playback
resumes from there. The gap is dropped (video skips it; the audio across
a 0.9 s hole is unrecoverable anyway) plus a ~300 ms gap while the
latency buffer refills. The `reset()` primitive already existed (track
re-anchoring); no worklet change was needed.

## Semantics and invariants

- **No audio is ever skipped.** Backlog is drained at up to 2.5× speed;
  at the floor the read is stock 1:1.
- **Time compression without time-stretching raises pitch with the rate**
  (2× ≈ +1 octave). Accepted: the catch-up is a bounded transient — the
  driven delay (entry 1000 ms → steady 300 ms after a 5 s window, buffer
  = 2× delay) keeps the backlog inside the ring capacity, so the rate
  settles to 1 within a second or two of the drain.
- **The writer is untouched.** Only the read cursor changes, and only
  forward. The fractional cursor is per-reader; the shared ring's
  publish protocol (epoch-guarded CAS on the packed read position) is
  unchanged.
- **`#readIndex` stays integral** in both rings; `#readPosF` is
  integration state only.

## Verifying

```
node third_party/moq-watch/check-worklet.mjs
# → worklet parses OK, … markers: 11
grep -c "campfire catch-up" client/node_modules/@moq/watch/player-*.js
# → 12 (11 worklet markers in the Blob literal + 1 main-bundle marker)
grep -c "campfire catch-up" client/dist/assets/index-*.js
# → 11 (after npm run build; the main-bundle marker is a comment and the
#   minifier drops it, the worklet literal survives; dist is embedded into
#   the server binary, so rebuild the server to pick up a re-patched bundle)
```

Behavior check (dev loop): force a backlog (DevTools CPU/network throttle
or a burst), watch `window.__campfire_moq_down[id].bufferedMs` (e2e
build) drain back to the delay floor, with audio audible the whole time
(faster, not skipped) and `delay` settling at the steady value.
