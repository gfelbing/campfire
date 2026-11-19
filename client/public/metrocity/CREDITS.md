# MetroCity avatar sheets

The modular avatar sprites (body/mid/bottom/top layers) are cut by hand
from the **MetroCity - Free Top Down Character Pack** by JIK-A-4
(CC0, https://jik-a-4.itch.io/metrocity-free-topdown-character-pack);
the hand-cut layer sheets live in `Metrocity_merged/` at the repo root.

`tools/metrocity/merge.py` merges them into the four atlas sheets served
from this directory:

* `body.png` — 6 skin tones (`Metrocity_merged/base`)
* `mid.png` — 11 upper-body garments (`mid`: Suit ×4, Suit1 ×5,
  Outfit2 + Outfit4)
* `bottom.png` — 11 lower-body garments (`bottom`: Suit ×4, Suit1 ×5,
  Outfit1 + Outfit3)
* `top.png` — head layers: 4 hair styles (the client tints them with the
  user's profile color), 3 caps, and an empty final row for the explicit
  "bald" pick (`top`: Hair.png + Suit.png; the pack's eyebrows-only Hair
  row and a blank Suit row are skipped)

All sheets: 32×32 cells, 24 columns = 4 directions (s/e/n/w) × 6
animation frames (0 = idle, 1–5 = walk).
