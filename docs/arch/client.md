# The web client

TypeScript + Vite + PixiJS (WebGL/WebGPU), built at compile time and embedded
into the server binary; `just dev` serves `client/dist` from disk instead.

```
client/src/
├── world/    # mapdata.ts (Tiled subset), render.ts (sprites + bubble), avatars.ts
├── net/      # WebTransport + SSE fallback, reconnect, token persistence
├── call/     # MoQ media (uplink + downlink), getUserMedia, bubble state machine
├── input/    # keyboard (walk 4 tiles/s, run 8)
└── ui/       # boot overlay, chat, presence, call theater
```

## Rendering

Tilesets are rendered as sprites: the client loads each tileset sheet from
`/api/v1/maps/<id>/<image>`, cuts per-tile frames (`firstgid`, `columns`,
`margin`, `spacing`) and draws every visible tile layer in Tiled draw order,
honoring horizontal/vertical tile flips. Collision layers shape walkability,
not the picture. Tiled **group layers** are flattened in draw order.

## Movement

- Local movement (WASD/arrows) with client-side prediction; sends at 15 Hz
  while moving, 2 Hz while idle. Remote avatars are interpolated between the
  server's 50 ms batched datagrams; name labels follow.
- **Click-to-walk**: a click routes the avatar along the shortest walkable
  path (BFS over the collision grid); keyboard input cancels.
- **Zoom**: scroll-wheel scaling of the map canvas, camera keeping the local
  avatar centered.

## Layout and zone visuals

- A collapsible sidebar next to the map (Main Menu / Players / Chat tabs) and
  a call theater overlapping the map while in a video call — remote streams
  stack in a column, screen sharing adds a tile, clicking a stream focuses it.
  The canvas resizes with the sidebar (`ResizeObserver`), not beneath it.
- Live call zones drawn as translucent green rectangles, proximity bubbles as
  a translucent one-tile circle, silent zones tinted gray; 🔇 do-not-disturb
  badge on avatars inside a `silentZone` (mirrored in the presence list);
  audio from silent-zone peers muted locally.

## Boot and identity

- Boot overlay: name, map picker, avatar color. A map named in the URL path
  suppresses the picker; joining from the landing page navigates to
  `/play/<map>/?name=…&color=…` — that URL is the room.
- Name, color and reconnect token live in `sessionStorage` (restored across
  reloads); reconnect-with-token also survives back/forward-cache navigation:
  the transport is closed on `pagehide` and rebuilt on `pageshow`, and
  transport generations keep stale death callbacks from racing the live one.
- When the server has OpenID Connect enabled, the name is forced from the
  IdP (`/api/v1/auth` probed on boot); visitors are redirected to the IdP.
