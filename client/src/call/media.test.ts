// Media preference persistence (call/media.ts): the topbar dropdowns'
// selections survive a reload; garbage storage falls back to defaults.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMediaPrefs, saveMediaPrefs, type MediaPrefs } from "./media";

describe("media prefs persistence", () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to the OS devices with noise suppression on", () => {
    expect(loadMediaPrefs()).toEqual({ noiseSuppression: true });
  });

  it("round-trips the selections", () => {
    const p: MediaPrefs = { cameraId: "cam-1", micId: "mic-1", noiseSuppression: false };
    saveMediaPrefs(p);
    expect(loadMediaPrefs()).toEqual(p);
  });

  it("falls back to defaults on garbage", () => {
    store["campfire.media"] = "{{{not json";
    expect(loadMediaPrefs()).toEqual({ noiseSuppression: true });
  });

  it("falls back to defaults on schema drift", () => {
    store["campfire.media"] = JSON.stringify({ cameraId: 42, noiseSuppression: "yes" });
    const p = loadMediaPrefs();
    expect(p.cameraId).toBeUndefined();
    expect(p.noiseSuppression).toBe(true);
  });

  it("persists across reloads (the same storage)", () => {
    saveMediaPrefs({ micId: "mic-2", noiseSuppression: true });
    expect(loadMediaPrefs().micId).toBe("mic-2");
  });
});
