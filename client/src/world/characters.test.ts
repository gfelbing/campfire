import { describe, expect, it, vi } from "vitest";

// The look module only needs pixi's texture plumbing when it slices the
// sheets; the pure helpers under test here never touch it.
vi.mock("pixi.js", () => {
  class Texture {}
  class Rectangle {
    x = 0;
    y = 0;
    width = 0;
    height = 0;
    constructor(x?: number, y?: number, width?: number, height?: number) {
      this.x = x ?? 0;
      this.y = y ?? 0;
      this.width = width ?? 0;
      this.height = height ?? 0;
    }
  }
  const Assets = { load: async () => undefined };
  return { Texture, Rectangle, Assets };
});

import {
  BOTTOM_COUNT,
  MID_COUNT,
  SKIN_COUNT,
  TOP_COUNT,
  deriveLook,
  isHairRow,
  normalizeLook,
  parseColor,
} from "./characters";

describe("deriveLook (stable fallback for users who never picked)", () => {
  it("stays within every sheet's row count", () => {
    for (const name of ["", "a", "georg", "vivid marten", "op∑l l∂ntern", "x".repeat(64)]) {
      const look = deriveLook(name);
      expect(look.skin).toBeGreaterThanOrEqual(0);
      expect(look.skin).toBeLessThan(SKIN_COUNT);
      expect(look.mid).toBeGreaterThanOrEqual(0);
      expect(look.mid).toBeLessThan(MID_COUNT);
      expect(look.top).toBeGreaterThanOrEqual(0);
      expect(look.top).toBeLessThan(TOP_COUNT);
      expect(look.bottom).toBeGreaterThanOrEqual(0);
      expect(look.bottom).toBeLessThan(BOTTOM_COUNT);
    }
  });

  it("is stable per name", () => {
    expect(deriveLook("georg")).toEqual(deriveLook("georg"));
    expect(deriveLook("georg")).not.toEqual(deriveLook("jules"));
  });

  it("marks only the first HAIR_ROWS top rows as hair", () => {
    expect(isHairRow({ ...deriveLook("a"), top: 0 })).toBe(true);
    expect(isHairRow({ ...deriveLook("a"), top: 3 })).toBe(true);
    expect(isHairRow({ ...deriveLook("a"), top: 4 })).toBe(false);
  });
});

describe("normalizeLook (bad wire values must not crash the renderer)", () => {
  const fb = { skin: 1, top: 2, mid: 3, bottom: 4 };

  it("keeps valid picks", () => {
    expect(normalizeLook({ skin: 0, top: 6, mid: 10, bottom: 10 }, fb)).toEqual({
      skin: 0,
      top: 6,
      mid: 10,
      bottom: 10,
    });
  });

  it("falls back on out-of-range, fractional and missing parts", () => {
    expect(normalizeLook({}, fb)).toEqual(fb);
    expect(normalizeLook({ skin: 99, top: 99, mid: 2.5 }, fb)).toEqual({
      skin: fb.skin,
      top: 2,
      mid: 3,
      bottom: 4,
    });
    expect(normalizeLook(undefined, fb)).toEqual(fb);
  });
});

describe("parseColor", () => {
  it("accepts #rgb and #rrggbb, rejects the rest", () => {
    expect(parseColor("#e05f38")).toBe(0xe05f38);
    expect(parseColor("#fff")).toBe(0xffffff);
    expect(parseColor("nope")).toBeNull();
  });
});
