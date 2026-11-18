// The topbar logo (ui/header.ts): a solid pixel-art flame (brand orange
// with the favicon's amber core) plus "Campfire" as a hand-rolled 5×7
// pixel wordmark, so the logo shares the map's visual language instead
// of mixing an emoji into the system font.
//
// Both halves are generated from tiny string bitmaps — the wordmark
// only needs the eight glyphs of its own name, so it carries a mini
// bitmap table rather than a webfont dependency. The flame is drawn
// solid: the pixelarticons `fire` icon is outline-style (rects with
// gaps), and on the dark topbar those gaps read as black holes.

/** 5×7 glyphs for the wordmark. '.' = off, '#' = on. */
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

/** The flame bitmap: 6×8, solid — 'o' = brand orange, 'a' = the
 *  favicon's amber (the glowing core at the base). */
const FLAME: string[] = [
  "...o..",
  "...o..",
  "..oo..",
  "..ooo.",
  ".oooo.",
  ".ooooo",
  "oooooo",
  "oaaaao",
];

const FLAME_COLORS: Record<string, string> = {
  o: "#e05f38",
  a: "#f2a25c",
};

const NS = "http://www.w3.org/2000/svg";

/** The wordmark as one `<path>` (a 1×1 square per lit pixel), 1 unit
 *  = 1 pixel. Ink spans x 0..8·ADVANCE−1, y 0..GLYPH_H. */
function wordmarkPath(): string {
  let d = "";
  for (let g = 0; g < WORD.length; g++) {
    const glyph = GLYPHS[WORD[g]!]!;
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row]![col] === "#") {
          const x = g * ADVANCE + col;
          d += `M${x} ${row}h1v1h-1z`;
        }
      }
    }
  }
  return d;
}

/** The logo, pixel units at 2× (the word) and 3× (the flame):
 *
 *  - flame: 6×8 bitmap × 3 → 18×24 px at x 0;
 *  - word:  47×7 bitmap × 2 → 94×14 px, centered on the flame's
 *    height (y = 5), at x 26 (an 8 px gap, the topbar's usual
 *    breathing room);
 *  - total 120×24.
 *
 *  The wordmark's fill is the theme's text color via an inline
 *  `var(--text)` style — currentColor through two nested SVGs proved
 *  unreliable (it rendered dark on the dark topbar). */
export function logoNode(): SVGSVGElement {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("width", "120");
  el.setAttribute("height", "24");
  el.setAttribute("viewBox", "0 0 120 24");
  el.setAttribute("shape-rendering", "crispEdges");
  el.setAttribute("aria-label", "Campfire");
  el.setAttribute("role", "img");

  const flame = document.createElementNS(NS, "svg");
  flame.setAttribute("width", "18");
  flame.setAttribute("height", "24");
  flame.setAttribute("viewBox", "0 0 6 8");
  flame.setAttribute("shape-rendering", "crispEdges");
  for (let row = 0; row < FLAME.length; row++) {
    for (let col = 0; col < FLAME[row]!.length; col++) {
      const c = FLAME[row]![col]!;
      if (c === ".") continue;
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", String(col));
      rect.setAttribute("y", String(row));
      rect.setAttribute("width", "1");
      rect.setAttribute("height", "1");
      rect.setAttribute("fill", FLAME_COLORS[c]!);
      flame.appendChild(rect);
    }
  }
  el.appendChild(flame);

  const word = document.createElementNS(NS, "svg");
  word.setAttribute("width", "94");
  word.setAttribute("height", "14");
  word.setAttribute("x", "26");
  word.setAttribute("y", "5");
  word.setAttribute("viewBox", `0 0 ${8 * ADVANCE - 1} ${GLYPH_H}`);
  word.setAttribute("shape-rendering", "crispEdges");
  word.style.fill = "var(--text)";
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", wordmarkPath());
  word.appendChild(path);
  el.appendChild(word);

  return el;
}
