// Character sprite sheets (client/public/characters/): 40 pre-drawn
// top-down characters (Jephed, Game Between The Lines — see the CREDITS.md
// next to the PNGs). Each sheet is 64×128 holding 12 cells of 20×32
// (3 columns × 4 rows): the rows are the four walk directions (south,
// west, east, north — top to bottom) and each row's three columns are the
// walk cycle, with the middle column the neutral (idle) frame.
//
// Loaded once up front; `AvatarView` renders a framed cell and falls back
// to the plain circle while the sheets are still loading (or when they are
// missing entirely, e.g. a broken deploy).

import { Assets, Rectangle, Texture } from "pixi.js";

import type { Dir } from "../net/types";

export const CHARACTER_COUNT = 40;
export const CELL_W = 20;
export const CELL_H = 32;
export const COLS = 3;
/** Sheet rows top→bottom: south, west, east, north. */
const DIR_ROW: Record<Dir, number> = { s: 0, w: 1, e: 2, n: 3 };
/** The walk cycle in cell columns: stride, neutral, stride — the loop a
 *  moving avatar plays; an idle avatar sits on the neutral cell. */
export const WALK_CYCLE = [1, 0, 1, 2] as const;
export const IDLE_COL = 1;
/** Walk animation rate: 4 frames at 12 fps ≈ one full cycle per ⅓ s —
 *  brisk enough for the 4 tiles/s walk speed. */
export const WALK_FRAME_MS = 84;

const sheets: Array<Texture | undefined> = [];
/** Variant+color → frame grid, generated on demand: the outfit band of
 *  the sheet recolored to the user's color (see `tintedFrames`). */
const tinted = new Map<number, Map<number, Texture[][]>>();

/** The outfit band in cell coordinates (y range): head above, legs
 *  below. Hair hangs into it on the side views — the overlay recolor
 *  just shifts its hue slightly. */
const TINT_TOP = 15;
const TINT_BOTTOM = 25;

/** Overlay-blend `color` into the RGBA `data`'s pixel band `y0..y1`,
 *  columns `x0..x1`: shifts the outfit's hue toward the color while
 *  keeping the shading (a multiply vanishes on the pack's dark clothes;
 *  a light color lightens, a dark one darkens). */
function recolorBand(
  d: Uint8ClampedArray,
  width: number,
  y0: number,
  y1: number,
  x0: number,
  x1: number,
  color: number,
): void {
  const tint = [(color >> 16) & 255, (color >> 8) & 255, color & 255];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if (d[i + 3] === 0) continue;
      for (let ch = 0; ch < 3; ch++) {
        const b = d[i + ch]! / 255;
        const t = tint[ch]! / 255;
        d[i + ch] = Math.round(
          255 * (b < 0.5 ? 2 * b * t : 1 - 2 * (1 - b) * (1 - t)),
        );
      }
    }
  }
}

/** Preload every character sheet (nearest sampling: the pixels stay
 *  crisp at any zoom). A missing sheet simply leaves its slot empty. */
export async function loadCharacters(): Promise<void> {
  await Promise.all(
    Array.from({ length: CHARACTER_COUNT }, (_, i) => {
      const url = `/characters/${String(i).padStart(3, "0")}.png`;
      return Assets.load<Texture>(url).then(
        (t) => {
          t.source.scaleMode = "nearest";
          sheets[i] = t;
        },
        () => undefined,
      );
    }),
  );
}

/** Stable avatar variant: hash the room-visible name into one of the
 *  sheets — the same person is the same character across reloads (the
 *  server-assigned id is random per session, the name is not). */
export function variantFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % CHARACTER_COUNT;
}

export function hasSheets(): boolean {
  return sheets[0] !== undefined;
}

export function dirRow(dir: Dir): number {
  return DIR_ROW[dir];
}

/** The `#rgb`/`#rrggbb` hex `color` as a number; `null` when malformed. */
export function parseColor(color: string): number | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim());
  if (!m) return null;
  let hex = m[1]!;
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return parseInt(hex, 16);
}

/** A standalone preview canvas of one character's idle south frame with
 *  the outfit recolored to the `#rrggbb` color — the profile menu's
 *  character picker thumbnails. `null` when the sheet is missing. */
export function previewCell(variant: number, color: string): HTMLCanvasElement | null {
  const sheet = sheets[variant];
  const tint = parseColor(color) ?? 0xffffff;
  if (!sheet) return null;
  const img = sheet.source.resource as HTMLImageElement | HTMLCanvasElement;
  const canvas = document.createElement("canvas");
  canvas.width = CELL_W;
  canvas.height = CELL_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(
    img,
    IDLE_COL * CELL_W, 0, CELL_W, CELL_H,
    0, 0, CELL_W, CELL_H,
  );
  const image = ctx.getImageData(0, 0, CELL_W, CELL_H);
  recolorBand(image.data, CELL_W, TINT_TOP, TINT_BOTTOM, 0, CELL_W, tint);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * The sheet's frames with the outfit recolored to `color`: the torso band
 * of every cell passes through an overlay blend toward the color, which
 * shifts the outfit's hue while keeping the shading (a pixi multiply
 * vanishes on the pack's dark clothes, and the non-multiply blend modes
 * do not render under a mask — so the tint is baked per variant+color
 * once, on the CPU, and cached).
 */
export function tintedFrames(variant: number, color: number): Texture[][] {
  // Numeric two-level cache: `refreshFrame` runs per avatar per frame, and
  // the old `${variant}:${color}` string key was one template allocation
  // per avatar per frame just for a cache lookup.
  let byColor = tinted.get(variant);
  if (!byColor) {
    byColor = new Map();
    tinted.set(variant, byColor);
  }
  const cached = byColor.get(color);
  if (cached) return cached;
  const sheet = sheets[variant];
  if (!sheet) return [];
  const img = sheet.source.resource as HTMLImageElement | HTMLCanvasElement;
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  recolorBand(image.data, canvas.width, TINT_TOP, TINT_BOTTOM, 0, CELL_W * COLS, color);
  ctx.putImageData(image, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  const grid: Texture[][] = [];
  for (let row = 0; row < 4; row++) {
    const cols: Texture[] = [];
    for (let col = 0; col < COLS; col++) {
      cols.push(
        new Texture({
          source: tex.source,
          frame: new Rectangle(col * CELL_W, row * CELL_H, CELL_W, CELL_H),
        }),
      );
    }
    grid.push(cols);
  }
  byColor.set(color, grid);
  return grid;
}
