// The modular avatar sheets (client/public/metrocity/, cut from the
// MetroCity pack by JIK-A-4 — see the CREDITS.md next to the PNGs): four
// layers that stack into one character.
//
// Every sheet is 32×32 cells in 24 columns: 4 direction blocks × 6
// animation frames. Direction blocks run south (columns 0–5), east (6–11),
// north (12–17), west (18–23); within a block frame 0 is the idle stance
// and frames 1–5 the walk cycle. A look is one row per layer: `body.png`
// carries 6 skin tones, `mid.png` 11 upper-body garments, `bottom.png` 11
// lower-body garments, and `top.png` 9 head layers — 5 hair styles
// (tinted with the user's profile color at render time) followed by 4
// caps (untinted). Compositing is a plain alpha stack of the same cell
// across the sheets.
//
// Loaded once up front; `AvatarView` renders the layer stack and falls
// back to a plain circle while the sheets are still loading (or when
// they are missing entirely, e.g. a broken deploy).

import { Assets, Rectangle, Texture } from "pixi.js";

import type { Dir } from "../net/types";

/** Option counts: one row per sheet. */
export const SKIN_COUNT = 6;
export const MID_COUNT = 11;
export const BOTTOM_COUNT = 11;
export const TOP_COUNT = 7;
/** The first `HAIR_ROWS` rows of `top.png` are hair (tinted with the
 *  profile color); the rest are caps (drawn as-is). */
export const HAIR_ROWS = 4;

export const CELL_W = 32;
export const CELL_H = 32;
export const COLS = 24;
/** Frames per direction block. */
export const FRAMES_PER_DIR = 6;
/** Column where each direction's block starts. */
const DIR_START: Record<Dir, number> = { s: 0, e: 6, n: 12, w: 18 };
/** The walk cycle in block-relative frames: the pack's six frames are a
 *  complete walk (two contact poses, two passes); an idle avatar sits on
 *  the contact pose (frame 0). */
export const WALK_CYCLE = [0, 1, 2, 3, 4, 5] as const;
export const IDLE_FRAME = 0;
/** Walk animation rate: 6 frames at ~17 fps — one full cycle (two steps,
 *  ≈2 tiles) per ⅓ s, matching the 6 tiles/s walk speed so the feet
 *  don't slide. */
export const WALK_FRAME_MS = 60;

export interface Look {
  /** `body.png` row (skin tone). */
  skin: number;
  /** `mid.png` row (upper-body garment). */
  mid: number;
  /** `bottom.png` row (lower-body garment). */
  bottom: number;
  /** `top.png` row (hair style or cap). */
  top: number;
}

/** Layer order (and draw order: body bottom-most, the head layer on
 *  top). */
export const BODY_LAYER = 0;
export const BOTTOM_LAYER = 1;
export const MID_LAYER = 2;
export const TOP_LAYER = 3;
export const LAYER_COUNT = 4;

/** The sheets as cell textures, `grid[layer][row][col]`. Empty until
 *  `loadAvatarSheets`. */
const grids: Texture[][][] = [];

const SHEETS = [
  { url: "/metrocity/body.png", rows: SKIN_COUNT },
  { url: "/metrocity/bottom.png", rows: BOTTOM_COUNT },
  { url: "/metrocity/mid.png", rows: MID_COUNT },
  { url: "/metrocity/top.png", rows: TOP_COUNT },
];

/** Preload the four sheets (nearest sampling: the pixels stay crisp at
 *  any zoom) and slice them into per-cell textures. A missing sheet
 *  leaves its layer empty — the avatars fall back to the circle. */
export async function loadAvatarSheets(): Promise<void> {
  await Promise.all(
    SHEETS.map(async (sheet, layer) => {
      let tex: Texture;
      try {
        tex = await Assets.load<Texture>(sheet.url);
      } catch {
        return; // missing sheet: the layer contributes nothing
      }
      tex.source.scaleMode = "nearest";
      const grid: Texture[][] = [];
      for (let row = 0; row < sheet.rows; row++) {
        const cols: Texture[] = [];
        for (let col = 0; col < COLS; col++) {
          cols.push(
            new Texture({
              source: tex.source,
              frame: new Rectangle(
                col * CELL_W,
                row * CELL_H,
                CELL_W,
                CELL_H,
              ),
            }),
          );
        }
        grid.push(cols);
      }
      grids[layer] = grid;
    }),
  );
}

export function hasSheets(): boolean {
  return grids[BODY_LAYER] !== undefined;
}

/** Stable derived look for users who never picked one (or old clients
 *  whose joins carry no look): hash the room-visible name into one row
 *  per layer — the same person is the same look across reloads (the
 *  server-assigned id is random per session, the name is not). */
export function deriveLook(name: string): Look {
  const hash = (salt: number): number => {
    let h = salt;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return Math.abs(h);
  };
  return {
    skin: hash(0) % SKIN_COUNT,
    mid: hash(0x51ed) % MID_COUNT,
    bottom: hash(0x2f6a) % BOTTOM_COUNT,
    top: hash(0x9e37) % TOP_COUNT,
  };
}

/** The look's row per layer (the render loop's per-layer pick). */
function rowOf(layer: number, look: Look): number {
  return [look.skin, look.bottom, look.mid, look.top][layer]!;
}

/** Clamp a look's parts into their sheets (a bad wire value must not
 *  crash the renderer). */
export function normalizeLook(
  look: Partial<Look> | undefined,
  fallback: Look,
): Look {
  const counts = [SKIN_COUNT, BOTTOM_COUNT, MID_COUNT, TOP_COUNT];
  const keys = ["skin", "bottom", "mid", "top"] as const;
  const out = { ...fallback };
  for (let layer = 0; layer < LAYER_COUNT; layer++) {
    const v = look?.[keys[layer]!];
    out[keys[layer]!] = typeof v === "number" && Number.isInteger(v) && v >= 0 && v < counts[layer]
      ? v
      : fallback[keys[layer]!];
  }
  return out;
}

/** Whether `look`'s head layer is hair (tinted with the profile color)
 *  rather than a cap (drawn as-is). */
export function isHairRow(look: Look): boolean {
  return look.top < HAIR_ROWS;
}

/** One layer's cell texture for `look`, `dir` and block-relative `frame`;
 *  `undefined` when the layer's sheet is missing. */
export function layerFrame(
  layer: number,
  look: Look,
  dir: Dir,
  frame: number,
): Texture | undefined {
  return grids[layer]?.[rowOf(layer, look)]?.[DIR_START[dir] + frame];
}

/** The `#rgb`/`#rrggbb` hex `color` as a number; `null` when malformed. */
export function parseColor(color: string): number | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim());
  if (!m) return null;
  let hex = m[1]!;
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return parseInt(hex, 16);
}

/** A standalone preview canvas of `look`'s cell (south, `frame`), the
 *  layers alpha-composited and the hair multiplied with `tint` (the
 *  profile color; caps stay untinted) — the profile modal's thumbnails
 *  and the profile button's face. `null` while the sheets are missing.
 *  `parts` hides layers (the part pickers show the picked layer alone). */
export function previewCell(
  look: Look,
  frame: number = IDLE_FRAME,
  parts: readonly number[] = [BODY_LAYER, BOTTOM_LAYER, MID_LAYER, TOP_LAYER],
  tint: number | null = null,
): HTMLCanvasElement | null {
  if (!hasSheets()) return null;
  const canvas = document.createElement("canvas");
  canvas.width = CELL_W;
  canvas.height = CELL_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  for (const layer of parts) {
    const tex = layerFrame(layer, look, "s", frame);
    if (!tex) continue;
    // The texture frames a cell of the loaded sheet image; its source
    // resource is that image element.
    const img = tex.source.resource as HTMLImageElement | HTMLCanvasElement;
    const fr = tex.frame;
    if (layer === TOP_LAYER && tint !== null && isHairRow(look)) {
      // Tint on a scratch canvas (multiply flattens transparent pixels,
      // so it must not touch the layers already on `canvas`), then stamp
      // the tinted hair over them.
      const scratch = document.createElement("canvas");
      scratch.width = CELL_W;
      scratch.height = CELL_H;
      const sctx = scratch.getContext("2d");
      if (!sctx) continue;
      sctx.drawImage(img, fr.x, fr.y, fr.width, fr.height, 0, 0, CELL_W, CELL_H);
      const hex = `#${(tint & 0xffffff).toString(16).padStart(6, "0")}`;
      sctx.globalCompositeOperation = "multiply";
      sctx.fillStyle = hex;
      sctx.fillRect(0, 0, CELL_W, CELL_H);
      sctx.globalCompositeOperation = "destination-in";
      sctx.drawImage(img, fr.x, fr.y, fr.width, fr.height, 0, 0, CELL_W, CELL_H);
      ctx.drawImage(scratch, 0, 0);
    } else {
      ctx.drawImage(img, fr.x, fr.y, fr.width, fr.height, 0, 0, CELL_W, CELL_H);
    }
  }
  return canvas;
}
