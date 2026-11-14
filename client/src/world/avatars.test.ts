import { describe, expect, it, vi } from "vitest";

// AvatarManager builds pixi display objects; stub the tiny API surface
// they touch so the interpolation math can run headless.
vi.mock("pixi.js", () => {
  class Vec {
    x = 0;
    y = 0;
    set(x: number, y: number): this {
      this.x = x;
      this.y = y;
      return this;
    }
  }
  class Container {
    position = new Vec();
    visible = true;
    addChild(..._children: unknown[]): void {}
    removeChild(..._children: unknown[]): void {}
    destroy(_options?: unknown): void {}
  }
  class Graphics {
    position = new Vec();
    clear(): this {
      return this;
    }
    circle(..._args: number[]): this {
      return this;
    }
    fill(_style?: unknown): this {
      return this;
    }
    stroke(_style?: unknown): this {
      return this;
    }
  }
  class Text {
    text: string;
    /** Only read for layout (`layoutStatusDot`); never measured here. */
    width = 0;
    y = 0;
    visible = true;
    anchor = new Vec();
    constructor(options?: { text?: string }) {
      this.text = options?.text ?? "";
    }
  }
  return { Container, Graphics, Text };
});

import { Container } from "pixi.js";
import { AvatarManager } from "./avatars";

describe("AvatarManager interpolation (issues.md latency of other avatars)", () => {
  it("does not throw on a just-joined remote (single snapshot, render point ahead)", () => {
    let t = 100_000;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    const m = new AvatarManager(new Container());
    m.joined({ id: "u1", name: "A" });
    // The render point (now - 140 ms) is still ahead of the single
    // snapshot: the pre-fix code read h[1] (undefined) and threw.
    m.update(t, 32);
    expect(m.positions().get("u1")).toEqual([0, 0]);
    t += 100;
    m.update(t, 32);
    expect(m.positions().get("u1")).toEqual([0, 0]);
  });

  it("interpolates between the snapshots bracketing the render point", () => {
    const m = new AvatarManager(new Container());
    let t = 100_000;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    m.joined({ id: "u1", name: "A" }); // (0,0) @ 100000
    t = 100_150;
    m.movement([{ id: "u1", x: 2, y: 0, d: "e", mv: 1, s: 1 }]); // (2,0) @ 100150
    // Render point 100080 sits between the two snapshots: 80/150 of the way.
    t = 100_220;
    m.update(t, 32);
    const p = m.positions().get("u1");
    expect(p?.[0]).toBeCloseTo((80 / 150) * 2, 5);
    expect(p?.[1]).toBe(0);
  });

  it("extrapolates briefly while moving, then freezes at the last position", () => {
    const m = new AvatarManager(new Container());
    let t = 100_000;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    m.joined({ id: "u1", name: "A" }); // (0,0) @ 100000
    t = 100_150;
    m.movement([{ id: "u1", x: 2, y: 0, d: "e", mv: 1, s: 1 }]); // (2,0) @ 100150
    // Render point 100260: 110 ms past the newest snapshot → still within
    // the 250 ms extrapolation margin, moving → advance along the motion.
    t = 100_400;
    m.update(t, 32);
    expect(m.positions().get("u1")?.[0]).toBeCloseTo(2 + (110 / 150) * 2, 5);
    // Render point 100560: 410 ms past → outside the margin → frozen.
    t = 100_700;
    m.update(t, 32);
    expect(m.positions().get("u1")).toEqual([2, 0]);
  });
});
