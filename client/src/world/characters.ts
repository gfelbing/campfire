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
const tinted = new Map<string, Texture[][]>();

/** The outfit band in cell coordinates (y range): head above, legs
 *  below. Hair hangs into it on the side views — the overlay recolor
 *  just shifts its hue slightly. */
const TINT_TOP = 15;
const TINT_BOTTOM = 25;

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

/**
 * The sheet's frames with the outfit recolored to `color`: the torso band
 * of every cell passes through an overlay blend toward the color, which
 * shifts the outfit's hue while keeping the shading (a pixi multiply
 * vanishes on the pack's dark clothes, and the non-multiply blend modes
 * do not render under a mask — so the tint is baked per variant+color
 * once, on the CPU, and cached).
 */
export function tintedFrames(variant: number, color: number): Texture[][] {
  const key = `${variant}:${color}`;
  const cached = tinted.get(key);
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
  const d = image.data;
  const tint = [(color >> 16) & 255, (color >> 8) & 255, color & 255];
  for (let row = 0; row < 4; row++) {
    const y0 = row * CELL_H + TINT_TOP;
    const y1 = row * CELL_H + TINT_BOTTOM;
    for (let y = y0; y < y1; y++) {
      // The three cell columns sit side by side, 20 px each.
      for (let x = 0; x < CELL_W * COLS; x++) {
        const i = (y * canvas.width + x) * 4;
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
  tinted.set(key, grid);
  return grid;
}
