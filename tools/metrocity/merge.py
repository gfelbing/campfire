#!/usr/bin/env python3
"""Build the modular avatar sheets (client/public/metrocity/) from the
hand-cut layer sheets in `Metrocity_merged/` (repo root; cut from the
MetroCity pack by JIK-A-4, CC0 — see CREDITS.md there).

The merged pack's layers, one folder per layer:

* base/Character Model.png — the body, 6 skin rows
* top/  — everything worn on the head: Hair.png (5 styles, the client
  tints them with the user's profile color) and Suit.png (4 caps)
* mid/  — upper-body garments: Suit.png (4), Suit1.png (5),
  Outfit2.png + Outfit4.png (1 row each)
* bottom/ — lower-body garments: Suit.png (4), Suit1.png (5),
  Outfit1.png (dress skirt) + Outfit3.png (skirt)

All sheets share a 32×32 cell grid with 24 columns: 4 direction blocks
(south 0–5, east 6–11, north 12–17, west 18–23) × 6 animation frames
(0 = idle, 1–5 = walk). Layers stack by compositing the same cell of
body, bottom, mid and top onto each other (draw order).

Atlas sheets built here (row indices = picker + wire option ids):

* body.png   — base rows
* top.png    — hair rows first, then the caps (the client tints a top
               row only when it is one of the first `hair` rows)
* mid.png    — the upper garments
* bottom.png — the lower garments
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "Metrocity_merged"
OUT = ROOT / "client" / "public" / "metrocity"

CELL_H = 32


def rows(img: Image.Image, skip: set[int] = frozenset()) -> list[Image.Image]:
    """The sheet's 32-px rows; `skip` drops empty/junk rows (the pack's
    `Hair.png` carries an eyebrows-only row and `Suit.png` a blank one,
    both render as a bald head)."""
    return [
        img.crop((0, r * CELL_H, img.width, (r + 1) * CELL_H))
        for r in range(img.height // CELL_H)
        if r not in skip
    ]


def stack(rows_: list[Image.Image]) -> Image.Image:
    out = Image.new("RGBA", (rows_[0].width, CELL_H * len(rows_)), (0, 0, 0, 0))
    for i, r in enumerate(rows_):
        out.paste(r, (0, i * CELL_H))
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    body = Image.open(SRC / "base" / "Character Model.png").convert("RGBA")
    body.save(OUT / "body.png")

    hair = Image.open(SRC / "top" / "Hair.png").convert("RGBA")
    hats = Image.open(SRC / "top" / "Suit.png").convert("RGBA")
    hair_rows = rows(hair, skip={1})  # row 1 is eyebrows, not a hairstyle
    hat_rows = rows(hats, skip={2})  # row 2 is blank
    stack(hair_rows + hat_rows).save(OUT / "top.png")

    mid_suits = Image.open(SRC / "mid" / "Suit.png").convert("RGBA")
    mid_shirts = Image.open(SRC / "mid" / "Suit1.png").convert("RGBA")
    mid_a = Image.open(SRC / "mid" / "Outfit2.png").convert("RGBA")
    mid_b = Image.open(SRC / "mid" / "Outfit4.png").convert("RGBA")
    mid_rows = (
        rows(mid_suits) + rows(mid_shirts) + rows(mid_a) + rows(mid_b)
    )
    stack(mid_rows).save(OUT / "mid.png")

    bot_suits = Image.open(SRC / "bottom" / "Suit.png").convert("RGBA")
    bot_shirts = Image.open(SRC / "bottom" / "Suit1.png").convert("RGBA")
    bot_a = Image.open(SRC / "bottom" / "Outfit1.png").convert("RGBA")
    bot_b = Image.open(SRC / "bottom" / "Outfit3.png").convert("RGBA")
    bottom_rows = (
        rows(bot_suits) + rows(bot_shirts) + rows(bot_a) + rows(bot_b)
    )
    stack(bottom_rows).save(OUT / "bottom.png")

    print(
        f"written to {OUT}: {len(hair_rows) + len(hat_rows)} tops "
        f"({len(hair_rows)} hair + {len(hat_rows)} hats), "
        f"{len(mid_rows)} mids, "
        f"{len(bottom_rows)} bottoms"
    )


if __name__ == "__main__":
    main()
