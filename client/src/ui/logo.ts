// The topbar logo (ui/header.ts): the pixelarticons flame (the same
// visual language as every other icon in the app) drawn two-tone —
// brand-orange body, amber core, the favicon's palette — plus
// "Campfire" as a hand-rolled 5×7 pixel wordmark, so the logo shares
// the map's visual language instead of mixing an emoji into the
// system font.
//
// The wordmark only needs the eight glyphs of its own name, so it
// carries a tiny bitmap table rather than a webfont dependency.

import fireRaw from "pixelarticons/svg/fire.svg?raw";

/** 5×7 glyphs for the wordmark. '.' = off, 'X' = on. */
const GLYPHS: Record<string, string[]> = {
  C: [
    ".###.",
    "#...#",
    "#....",
    "#....",
    "#....",
    "#...#",
    ".###.",
  ],
  a: [
    ".....",
    ".....",
    ".###.",
    "....#",
    ".####",
    "#...#",
    ".####",
  ],
  m: [
    ".....",
    ".....",
    "##.#.",
    "#.#.#",
    "#.#.#",
    "#.#.#",
    "#.#.#",
  ],
  p: [
    ".....",
    ".....",
    "####.",
    "#...#",
    "####.",
    "#....",
    "#....",
  ],
  f: [
    "..###",
    ".#...",
    "####.",
    ".#...",
    ".#...",
    ".#...",
    ".#...",
  ],
  i: [
    "..#..",
    ".....",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
    "..#..",
  ],
  r: [
    ".....",
    ".....",
    "#.###",
    "##...",
    "#....",
    "#....",
    "#....",
  ],
  e: [
    ".....",
    ".....",
    ".###.",
    "#...#",
    "#####",
    "#....",
    ".####",
  ],
};

const ADVANCE = 6; // glyph width + 1 px spacing
const GLYPH_H = 7;
const WORD = "Campfire";

/** The wordmark as one `<path>` (a 1×1 square per lit pixel), 1 unit
 *  = 1 pixel. Ink spans x 0..8·ADVANCE−1, y 0..GLYPH_H. */
function wordmarkPath(): string {
  let d = "";
  for (let g = 0; g < WORD.length; g++) {
    const glyph = GLYPHS[WORD[g]!]!;
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row]![col] === "X") {
          const x = g * ADVANCE + col;
          d += `M${x} ${row}h1v1h-1z`;
        }
      }
    }
  }
  return d;
}

/** The logo: flame (24 px, two-tone) + wordmark (2× pixel scale),
 *  vertically centered for the topbar. */
export function logoNode(): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("width", "128");
  el.setAttribute("height", "24");
  el.setAttribute("viewBox", "0 0 128 24");
  el.setAttribute("shape-rendering", "crispEdges");
  el.setAttribute("aria-label", "Campfire");
  el.setAttribute("role", "img");

  // The flame: the pixelarticons source re-colored per path — the body
  // in the brand orange, the core in the favicon's amber. The original
  // `fill="currentColor"` is on the root svg; the per-path fills
  // override it.
  const flame = new DOMParser().parseFromString(fireRaw, "image/svg+xml")
    .documentElement;
  const [body, core] = [...flame.querySelectorAll("path")];
  body?.setAttribute("fill", "#e05f38");
  core?.setAttribute("fill", "#f2a25c");
  flame.setAttribute("width", "24");
  flame.setAttribute("height", "24");
  flame.setAttribute("x", "0");
  flame.setAttribute("y", "0");
  el.appendChild(flame);

  // The wordmark: 48 units wide × 7 tall, rendered at 2× → 96×14,
  // centered on the flame's height (y = (24 − 14) / 2 = 5).
  const word = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  word.setAttribute("width", "96");
  word.setAttribute("height", "14");
  word.setAttribute("x", "29");
  word.setAttribute("y", "5");
  word.setAttribute("viewBox", `0 0 ${8 * ADVANCE - 1} ${GLYPH_H}`);
  word.setAttribute("fill", "currentColor");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", wordmarkPath());
  word.appendChild(path);
  el.appendChild(word);

  return el;
}
