//! The noise-gate algorithm (call/denoiser.ts), tested against the exact
//! shipped worklet source: `GATE_WORKLET_SOURCE` is evaluated in a
//! sandbox with stubbed AudioWorklet globals and the registered
//! processor is driven directly with Float32Arrays — the DSP is the
//! production code, not a reimplementation.

import { describe, expect, it } from "vitest";
import { GATE_PROCESSOR, GATE_WORKLET_SOURCE } from "./denoiser";

/** Evaluate the worklet source with browser-AudioWorklet stubs and hand
 *  back the registered processor class. */
function loadProcessor(): new (options?: { processorOptions?: { enabled?: boolean } }) => {
  port: { onmessage: ((ev: { data: { enabled: boolean } }) => void) | null; postMessage: (m: unknown) => void };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
} {
  const registry: Record<string, unknown> = {};
  const sandbox = new Function(
    "registerProcessor",
    "AudioWorkletProcessor",
    "sampleRate",
    `${GATE_WORKLET_SOURCE}\nreturn registerProcessor;`,
  ) as (register: (n: string, c: unknown) => void, base: unknown, rate: number) => (n: string, c: unknown) => void;
  sandbox(
    (name: string, cls: unknown) => {
      registry[name] = cls;
    },
    class {
      port = { postMessage: () => {} };
    },
    48000,
  );
  const processor = registry[GATE_PROCESSOR];
  expect(processor).toBeDefined();
  return processor as never;
}

/** One mono process call, N samples, chunked into 128-sample quanta
 *  exactly like the real AudioWorklet invocation — the floor's decay
 *  pass and percentile walk run once per quantum, so driving `process`
 *  with the whole buffer at once would skip the adaptation entirely. */
function run(
  proc: ReturnType<typeof loadProcessor> extends new () => infer P ? P : never,
  input: Float32Array,
): Float32Array {
  const output = new Float32Array(input.length);
  const QUANTUM = 128;
  for (let at = 0; at < input.length; at += QUANTUM) {
    const end = Math.min(at + QUANTUM, input.length);
    proc.process(
      [[input.subarray(at, end)]],
      [[output.subarray(at, end)]],
    );
  }
  return output;
}

const rms = (x: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / x.length);
};

/** Deterministic pseudo-noise (a plain LCG — reproducible across runs). */
function noise(n: number, sigma: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (((s / 0x3fffffff) - 1) * 2) * sigma;
  }
  return out;
}

/** Speech-pause shape: 300 ms tone bursts, 300 ms pauses — a real
 *  inter-word pause. (The e2e's own 150 ms/100 ms train is shorter than
 *  the gate's hold by design — it must survive the gate untouched; this
 *  shape exercises the actual gating.) */
function speechTrain(seconds: number, amplitude: number, floorSigma: number): Float32Array {
  const rate = 48000;
  const n = Math.floor(seconds * rate);
  const out = new Float32Array(n);
  const floor = noise(n, floorSigma, 7);
  for (let i = 0; i < n; i++) {
    const t = (i % Math.floor(rate * 0.6)) / rate;
    const burst = t < 0.3 ? Math.sin((2 * Math.PI * 220 * i) / rate) * amplitude : 0;
    out[i] = burst + floor[i];
  }
  return out;
}

describe("noise gate (the shipped worklet source)", () => {
  it("registers under its documented name", () => {
    expect(() => loadProcessor()).not.toThrow();
  });

  it("attenuates a steady noise floor by well over 10 dB", () => {
    const proc = new (loadProcessor())();
    const input = noise(48000 * 4, 0.01); // −40 dBFS floor, 4 s
    const output = run(proc, input);
    // Measure the tail (past the gate's attack and floor settle).
    const tail = 48000;
    const inRms = rms(input.subarray(input.length - tail));
    const outRms = rms(output.subarray(output.length - tail));
    const db = 20 * Math.log10(outRms / inRms);
    expect(db).toBeLessThan(-10);
  });

  it("passes speech bursts above the floor nearly untouched", () => {
    const proc = new (loadProcessor())();
    const input = speechTrain(6, 0.1, 0.01);
    const output = run(proc, input);
    // During bursts (the top half of the envelope) the gate must be
    // open: compare burst-window RMS in and out.
    const burstRms = (x: Float32Array): number => {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < x.length; i++) {
        if (Math.abs(input[i]) > 0.05) {
          sum += x[i] * x[i];
          count++;
        }
      }
      return Math.sqrt(sum / count);
    };
    const ratio = burstRms(output) / burstRms(input);
    expect(ratio).toBeGreaterThan(0.7);
  });

  it("keeps the noise floor down between bursts (the complaint's case)", () => {
    const open = new (loadProcessor())();
    const outOpen = run(open, speechTrain(8, 0.1, 0.01));
    const bypass = new (loadProcessor())({ processorOptions: { enabled: false } });
    const outRaw = run(bypass, speechTrain(8, 0.1, 0.01));
    // Noise-only windows: by PHASE — and the *tail* of the pause, the
    // last 150 ms before the next burst. The gate's hold keeps the
    // first 150 ms of a pause open deliberately (a short dip must not
    // clip the next word's onset); the tail is where the gate reaches
    // full depth. A burst's own zero crossings dip under any amplitude
    // threshold, so classification has to be by phase either way.
    const gapRms = (x: Float32Array): number => {
      let sum = 0;
      let count = 0;
      const rate = 48000;
      for (let i = 0; i < x.length; i++) {
        const phase = (i % Math.floor(rate * 0.6)) / rate;
        if (phase >= 0.52) {
          sum += x[i] * x[i];
          count++;
        }
      }
      return Math.sqrt(sum / count);
    };
    const rawFloor = gapRms(outRaw);
    const gatedFloor = gapRms(outOpen);
    const db = 20 * Math.log10(gatedFloor / rawFloor);
    expect(db).toBeLessThan(-6);
  });

  it("re-gates when the background itself gets louder (fan spin-up)", { timeout: 30_000 }, () => {
    const proc = new (loadProcessor())();
    // 10 s of quiet floor (gate settles), then a step to a loud floor.
    const quiet = noise(48000 * 10, 0.003);
    const loud = noise(48000 * 10, 0.03, 9);
    const input = new Float32Array(quiet.length + loud.length);
    input.set(quiet, 0);
    input.set(loud, quiet.length);
    const output = run(proc, input);
    // Early in the loud stretch the gate is (legitimately) still open;
    // by the tail the steady-state detector must have climbed the floor
    // and re-gated.
    const tail = output.subarray(output.length - 48000);
    const inTail = rms(loud.subarray(loud.length - 48000));
    const outTail = rms(tail);
    const db = 20 * Math.log10(outTail / inTail);
    expect(db).toBeLessThan(-6);
  });

  it("bypass is bit-transparent", () => {
    const proc = new (loadProcessor())({ processorOptions: { enabled: false } });
    const input = speechTrain(2, 0.2, 0.02);
    const output = run(proc, input);
    for (let i = 0; i < input.length; i++) {
      expect(output[i]).toBe(input[i]);
    }
  });

  it("stays finite and bounded over a long mixed run", { timeout: 30_000 }, () => {
    const proc = new (loadProcessor())();
    const input = speechTrain(20, 0.5, 0.02);
    const output = run(proc, input);
    for (let i = 0; i < output.length; i++) {
      expect(Number.isFinite(output[i])).toBe(true);
      expect(Math.abs(output[i])).toBeLessThanOrEqual(1);
    }
  });

  it("the toggle message flips between gating and bypass", () => {
    const proc = new (loadProcessor())();
    const input = noise(48000, 0.01);
    const gated = run(proc, input);
    const gatedRms = rms(gated);

    const proc2 = new (loadProcessor())();
    proc2.port.onmessage?.({ data: { enabled: false } });
    const bypassed = run(proc2, input);
    // Identical input, identical fresh processor, bypass via the
    // message: the output must be the input.
    for (let i = 0; i < input.length; i++) {
      expect(bypassed[i]).toBe(input[i]);
    }
    expect(gatedRms).toBeLessThan(rms(input) * 0.7);
  });
});
