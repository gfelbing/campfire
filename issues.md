# 1 status handling

* when entering a map initially, status should be initialized with online
* when browser gets out of focus and status was online, it should switch to away
* when browser gets into focus and status was away, it should switch to online
* DnD status should never automatically change
* status switcher should become its own item in the topbar

## analysis

`boot.ts` `loadStatus()` currently persists the last status across reloads, so a user who left as `away`/`dnd` re-enters the map in that status. Per the spec, initial status must always be `online`.

`main.ts` already listens to `visibilitychange` and guards auto-away: it only switches to `away` when the current status is `online`, and on refocus it only restores `autoAway` (its own flag). Under the new spec, refocus should switch **any** `away` status (manual or automatic) back to `online`; `dnd` must never change automatically in either direction.

The status switcher today lives as rows inside the profile menu; it needs to move to its own topbar button with a popover.

## plan

1. `boot.ts`: initialize status as `online` on every fresh load (do not restore a persisted non-online status).
2. `main.ts` visibility handling:
   - hidden && status === `online` → `away` (unchanged).
   - visible && status === `away` (manual or auto) → `online`.
   - never touch `dnd` from either handler.
3. UI: new topbar status button (dot + label) opening a popover with the status options; remove the status rows from the profile menu.
4. Verify: reload keeps spec'd behavior, dnd survives hide/show, manual away restores on focus.

# 2 chat

i'd like to rework the chat functionality

## new concept

there should be 2 chats:

1. a global one for the whole room
2. a local one for the current bubble

* the second one should only be there when in a bubble
* chat icons in the sidebar should have an indicator when there are messages 
* chats should not be spammed with status messages

## analysis

Today there is one chat per room; messages have no scope, and system/log/error lines are fed into the chat via `main.ts` `onLog`/`onError` → `chat?.system`, which is the "status spam".

Protocol change needed on the server: `ChatMsg` gains a `scope` field (`"room"` | `"call"`). The server keeps two histories per room and broadcasts by scope (a call-scoped message goes to call participants regardless of sender room membership — verified during testing that scoping itself works). The `hello` history response returns both lists, scope-filtered.

On the client, the sidebar already has a second accordion ("Bubble chat"); the "empty accordion" symptom seen in testing was a stale embedded bundle (`include_dir!` bakes `client/dist` at binary build time), not a code bug. The bubble chat UI should only exist while in a call, with unread indicators on the sidebar rail icons and accordion headers.

## plan

1. Server: add `scope: "room" | "call"` to `ChatMsg`; two histories per room; broadcast by scope; `hello` returns both scoped lists. Migration: old messages default to `room` scope.
2. Client: split chat state into room + bubble channels; render bubble chat only while in a call.
3. System messages: reroute `onLog`/`onError` out of the chats (toast/status line instead of `chat?.system`).
4. Unread indicators on rail icons and accordion headers, cleared on open.
5. Rebuild client and force server re-embed (touch a server source file) before testing — `cargo` does not track `client/dist`.

# 3 call theater

* in the call theater, it should show the resolution of each stream
* delay indicator always shows 300ms
* video resolution should be capped to 800x600 maximum
* turning off the camera shows the last image to others

## analysis

- **Resolution display**: the decoded frame size is not surfaced anywhere; `DownlinkView` needs to expose the decoded width/height so the theater tile can render it.
- **Delay stuck at 300ms**: bug at `client/src/call/moq.ts:889` — `delay: Number(d.sync.out.delay.peek())` reads the **uplink** (`out`) delay signal, which sits at a steady 300 ms, instead of the downlink playback delay.
- **Resolution cap**: `client/src/call/media.ts` camera constraints use `ideal: 1280x720`; cap to 800x600 max.
- **Camera off**: when a sender turns the camera off, receiver canvases keep showing the last decoded frame. `call_mute video=false` presence already arrives at receivers, so the fix is receiver-side: blank/hide the canvas when `videoOn` is false.

## plan

1. `DownlinkView`: expose decoded frame width/height; render `WxH` label in the theater tile (next to the delay indicator).
2. `moq.ts:889`: read the downlink playback delay signal, not `d.sync.out.delay`.
3. `media.ts`: video constraints `width/height: { ideal: 800/600, max: 800/600 }`.
4. Receiver-side: when a participant's `videoOn` is false, hide/blank their canvas instead of leaving the last frame.

# 4 auth

* when enabling auth, login works
* but the connection to /wt fails with net::ERR_QUIC_PROTOCOL_ERROR

## analysis

`handle_wt` (`realtime.rs:69`) calls `enforce_auth` and responds with a plain 401 **before** `upgrade.accept()`. The 401 path is unverified: either the session cookie never arrives on the WebTransport request (cookie not sent for the WT request), or a plain HTTP 401 response to an extended CONNECT breaks the H3 handshake, surfacing as `ERR_QUIC_PROTOCOL_ERROR` in the browser.

`/moq/{ticket}` uses a ticket instead of the cookie and needs a check too.

## plan

1. Reproduce with a mock IdP and auth enabled.
2. Log whether the session cookie reaches `handle_wt` at all.
3. If the cookie is missing: fix cookie delivery for the WT request.
4. If the cookie is present: make the auth reject protocol-clean for extended CONNECT (proper H3/CONNECT error response instead of a plain 401 body).
5. Audit `/moq/{ticket}` auth path for the same class of problem.

# 5 profile

* cannot type WASD in profile as they are bound to walking
* also cannot use the arrows

## analysis

`client/src/input/keys.ts` registers a global keydown/keyup listener with no target filtering, so typing in the profile form's text inputs also drives movement.

## plan

In the keydown/keyup handlers, skip handling when `e.target` is an `INPUT`, `TEXTAREA`, `SELECT` or `contentEditable` element. Also check for the same pattern on any other global input listeners.

# 6 delay in the beginning

* 1s delay in the beginning of a call is highly confusing
* i'd like to remove it for now.

## analysis

`client/src/call/moq.ts:36` defines `ENTRY_DELAY_MS = 1000` (steady delay is 300 ms, line 37). The 1 s entry ramp smooths startup but is confusing in practice.

## plan

Set `ENTRY_DELAY_MS` to the steady value (300) so the ramp is effectively a no-op, keeping the ramp machinery in place but dormant. Verify startup audio/video sync feels immediate and the delay indicator shows ~300 ms.

# 7 connection degraded

after hanging out with 3 people for a while, the connection degraded. server logs:

```
2026-11-12T07:26:34.653196Z  WARN campfire_server::moq::h3wt: h3wt bridge error op=recv_stream.read err=ConnectionError: Timeout                                                              
2026-11-12T07:26:34.653443Z  WARN campfire_server::moq::session: moq session ended err=internal error                                                                                         
2026-11-12T07:27:04.654164Z  WARN campfire_server::moq::h3wt: h3wt bridge error op=recv_stream.read err=ConnectionError: Timeout                                                              
2026-11-12T07:27:04.654322Z  WARN campfire_server::moq::session: moq session ended err=internal error                                                                                         
2026-11-12T07:30:32.213243Z  WARN campfire_server::moq::h3wt: h3wt bridge error op=send_stream.write err=StreamClosed: 0x52e4a40fa8dc                                                         
2026-11-12T07:30:36.909777Z  WARN campfire_server::moq::h3wt: h3wt bridge error op=send_stream.write err=StreamClosed: 0x52e4a40fa8dc                                                         
2026-11-12T07:30:37.522991Z  WARN campfire_server::moq::h3wt: h3wt bridge error op=send_stream.write err=StreamClosed: 0x52e4a40fa8dc                                                         
2026-11-12T07:30:40.220346Z  WARN campfire_server::moq::h3wt: h3wt bridge error op=send_stream.write err=StreamClosed: 0x52e4a40fa8dc                                                         
2026-11-12T07:30:48.551548Z  INFO campfire_server::moq::session: moq session admitted version=Lite(Lite02) call=14                                                                            
2026-11-12T07:30:48.896769Z  INFO campfire_server::moq::session: moq session admitted version=Lite(Lite02) call=14                                                                            
                                                                                                                                                                                              
thread 'tokio-rt-worker' (7) panicked at /usr/local/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/h3-quinn-0.0.10/src/lib.rs:394:14:                                                    
called `Option::unwrap()` on a `None` value                                                                                                                                                   
                                                                                                                                                                                              
thread 'tokio-rt-worker' (7) panicked at /usr/local/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/h3-quinn-0.0.10/src/lib.rs:394:14:                                                    
called `Option::unwrap()` on a `None` value                                                                                                                                                   
                                                                                                                                                                                              
thread 'tokio-rt-worker' (7) panicked at /usr/local/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/h3-quinn-0.0.10/src/lib.rs:394:14:                                                    
called `Option::unwrap()` on a `None` value                                                                                                                                                   
                                                                                                                                                                                              
thread 'tokio-rt-worker' (7) panicked at /usr/local/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/h3-quinn-0.0.10/src/lib.rs:394:14:                                                    
called `Option::unwrap()` on a `None` value                                                                                                                                                   
                                                                                                                                                                                              
thread 'tokio-rt-worker' (7) panicked at /usr/local/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/h3-quinn-0.0.10/src/lib.rs:394:14:                                                    
called `Option::unwrap()` on a `None` value                                                                                                                                                   
2026-11-12T07:31:17.007195Z  WARN campfire_server::moq::h3wt: h3wt bridge error op=recv_stream.read err=ConnectionError: Timeout                                                              
2026-11-12T07:31:17.007472Z  WARN campfire_server::moq::session: moq session ended err=internal error                                                                                         
2026-11-12T07:31:17.851314Z  WARN campfire_server::moq::h3wt: h3wt bridge error op=recv_stream.read err=ConnectionError: Timeout                                                              
2026-11-12T07:31:17.851475Z  WARN campfire_server::moq::session: moq session ended err=internal error 
```

## analysis

The panic path is `/usr/local/cargo/registry/.../h3-quinn-0.0.10/src/lib.rs:394` — a **crates.io registry path**, i.e. the unpatched crate. The vendored `third_party/h3-quinn` fix (see its `PATCH.md`, the `stop_sending`/`recv_id` fix) landed with 0.0.7 (released 19:34), but these logs are from 07:26 the same morning — before the fix. So this exact failure should already be resolved by the current build.

Remaining questions: does the deployed binary actually link the vendored h3-quinn, and why did connections time out (`recv_stream.read Timeout` → session ended) in the first place? The timeouts suggest missing keep-alive on long-idle sessions.

## plan

1. Verify deployment builds against the vendored `third_party/h3-quinn` (path dependency, not registry) so the panic fix is actually in the binary.
2. Confirm `keep_alive_interval` (`tls.rs:64`, set to `idle_timeout / 3`) applies to the MoQ/WebTransport listener too, so idle sessions ping instead of timing out.
3. Soak test with 3 participants for an extended period; watch for `ConnectionError: Timeout` / `StreamClosed` warnings and any panic.
