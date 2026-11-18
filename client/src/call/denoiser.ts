//! Uplink noise gate (docs/arch/protocol.md): the mic chain between the
//! browser's capture and the MoQ publish pipeline.
//!
//! The "Noise cancellation" toggle used to control only the browser's
//! built-in `noiseSuppression` constraint — the APM noise suppressor,
//! which is mild by design. With the preference defaulting to on,
//! toggling it changed next to nothing: the complaint "the noise
//! cancellation barely has effect". This chain adds a real, tunable
//! stage: a high-pass (rumble/hum), an adaptive noise-floor estimate,
//! and a soft gate that attenuates anything sitting at the floor by
//! ~22 dB while riding speech (attack ~10 ms, hold 150 ms covers
//! inter-word gaps, release ~100 ms). The floor only adapts while the
//! gate is closed, and a steady-state detector lets it climb when the
//! background itself gets louder — so a fan spinning up re-gates within
//! seconds without the floor chasing speech.
//!
//! The toggle drives this gate only — the browser's own
//! `noiseSuppression` stays at its default either way (turning the gate
//! off must keep the browser default, not strip the mic of its
//! processing).
//!
//! The gate algorithm lives in `GATE_WORKLET_SOURCE` as a
//! self-contained string (the worklet thread needs source text for
//! `addModule`, same shape as `@moq/watch`'s render worklet), and the
//! unit tests in `denoiser.test.ts` execute that exact string against a
//! stubbed `AudioWorkletProcessor` — one source of truth, tested
//! without a browser.

/** The worklet source. Self-contained: no imports, all constants local,
 *  so it survives minification and `Blob` compilation unchanged. The
 *  processor is mono-in/mono-out; the chain forces the node and the
 *  destination to explicit mono (a stereo uplink halves Opus's bitrate
 *  budget per channel). */
export const GATE_WORKLET_SOURCE = `
// Gate parameters. Tuned against the e2e's synthetic speech train
// (150 ms tones, ~100 ms gaps): the hold keeps gain open across the
// gaps, so the continuity assertions see an unbroken signal.
const MARGIN = 4;        // open when the envelope is 12 dB over the floor
const LOW = 0.08;        // gated gain (-22 dB) — attenuate, not mute
const HOLD = 7200;       // 150 ms at 48 kHz
const OPEN_RATE = 1 / 480;    // ~10 ms attack toward open
const CLOSE_RATE = 1 / 2400;  // ~50 ms release toward LOW (a 300 ms pause
                              // reaches full depth; slower leaves the
                              // gate only part-way closed by the next
                              // word, which is what made the toggle feel
                              // like it did nothing)
const ENV_UP = 1 / 1440;      // envelope attack ~30 ms
const ENV_DOWN = 1 / 1440;    // envelope release ~30 ms — must fall fast
                              // enough to reach the true floor within a
                              // speech pause (the histogram reads THIS
                              // level; a 100 ms tau would still read the
                              // burst level after a 100 ms gap)
const HP_A = 0.98954;         // one-pole high-pass, ~80 Hz at 48 kHz

// The noise floor comes from a decaying log-histogram of the envelope
// over the last few seconds — the standard trick that survives real
// speech: bursts pile mass into the high bins while the low percentile
// stays at the background level, a louder fan migrates the mass upward
// (and the percentile follows within a couple of seconds), and a
// quieter one decays the old bin away. A slow-envelope minimum cannot
// do this: with a ~1 s tau its minimum sits at the *average* level of
// a speech train, not the pauses, and the gate would swallow the
// speech with the noise.
const BINS = 32;          // log-spaced from 1e-9 to 1
const LOG_LO = -9;
const LOG_SPAN = 9;       // log10 span: -9 .. 0
const PERCENTILE = 0.1;   // the floor sits under the lowest 10% of mass
const DECAY = 0.99877;    // per process call (~2.7 ms): a bin's half-life ~1.5 s
const BIN_W = LOG_SPAN / BINS;                    // each bin's decade width

class Gate {
  constructor() {
    this.enabled = true;
    this.x1 = 0;        // DC-blocker input memory
    this.y1 = 0;        // DC-blocker output memory
    this.env = 0;       // fast envelope (speech level)
    this.counts = new Float32Array(BINS);
    this.floor = 0;     // background estimate (histogram percentile)
    this.gain = 1;      // smoothed gate gain
    this.hold = 0;      // samples of hold left
  }

  // One sample in, one out. The gate is bypassed entirely when disabled
  // (the OFF path is the browser's default processing, untouched).
  step(x) {
    if (!this.enabled) return x;
    // DC blocker (one-pole high-pass): kills rumble and handler thumps
    // before the envelope sees them, so the floor is not inflated by
    // sub-audio energy.
    const y = x - this.x1 + HP_A * this.y1;
    this.x1 = x;
    this.y1 = y;

    const ax = Math.abs(y);
    this.env += (ax - this.env) * (ax > this.env ? ENV_UP : ENV_DOWN);

    const open = this.env > this.floor * MARGIN;
    if (open) {
      this.hold = HOLD;
    } else if (this.hold > 0) {
      this.hold--;
    }

    // Gate gain: open fast, close slowly, hold across short gaps.
    const target = open || this.hold > 0 ? 1 : LOW;
    const rate = target > this.gain ? OPEN_RATE : CLOSE_RATE;
    this.gain += (target - this.gain) * rate;

    // Histogram: the *envelope's* level binned logarithmically — the
    // gate compares against the envelope, so the floor must be the
    // envelope's own percentile (binning the raw samples would sit
    // ~10 dB under it and the gate would never close). One bin index
    // per sample is cheap; the decay pass and the percentile walk run
    // once per process call (below).
    let bin = ((Math.log10(this.env > 1e-9 ? this.env : 1e-9) - LOG_LO) / LOG_SPAN) * BINS;
    bin = bin < 0 ? 0 : bin >= BINS ? BINS - 1 : bin | 0;
    this.counts[bin]++;

    return y * this.gain;
  }

  // The noise floor: the envelope level under which the lowest 10% of
  // the windowed histogram mass sits. Called once per process call.
  updateFloor() {
    let total = 0;
    for (let i = 0; i < BINS; i++) {
      this.counts[i] *= DECAY;
      total += this.counts[i];
    }
    if (total <= 0) return;
    const target = total * PERCENTILE;
    let cum = 0;
    for (let i = 0; i < BINS; i++) {
      cum += this.counts[i];
      if (cum >= target) {
        // The bin's LOWER edge: with 0.28 decades per bin the center
        // can read above the envelope's own level, which would close
        // the gate on quiet speech. The lower edge reads slightly
        // under, erring toward letting speech through.
        this.floor = Math.pow(10, LOG_LO + i * BIN_W);
        return;
      }
    }
    this.floor = Math.pow(10, LOG_LO + LOG_SPAN);
  }
}

class DenoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.gate = new Gate();
    if (options && options.processorOptions && options.processorOptions.enabled === false) {
      this.gate.enabled = false;
    }
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && typeof data.enabled === "boolean") this.gate.enabled = data.enabled;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0][0];
    if (!input || !output) return true;
    for (let i = 0; i < input.length; i++) {
      output[i] = this.gate.step(input[i]);
    }
    this.gate.updateFloor();
    return true;
  }
}

registerProcessor("campfire-denoise", DenoiseProcessor);
`;

/** The worklet processor name, for tests and the register check. */
export const GATE_PROCESSOR = "campfire-denoise";

/** Wrap a raw mic track in the denoise chain: a dedicated `AudioContext`
 *  running the gate worklet, mono in and out (the chain's destination
 *  track feeds the MoQ publish pipeline — a stereo uplink would halve
 *  Opus's bitrate budget per channel). Returns the processed
 *  replacement track to hand to the publisher; the raw track stays with
 *  the caller (mute constraints and `getSettings().deviceId` read it —
 *  the processed track reports no device). `enabled` seeds the toggle:
 *  false = raw bypass. Resolves `null` when the worklet module cannot
 *  load (no gate; the caller falls back to the raw track). */
export class Denoiser {
  /** The processed audio track (the publish pipeline's input). */
  readonly track: MediaStreamTrack;
  private readonly context: AudioContext;
  private readonly node: AudioWorkletNode;
  private readonly source: MediaStreamAudioSourceNode;

  private constructor(
    context: AudioContext,
    node: AudioWorkletNode,
    source: MediaStreamAudioSourceNode,
    track: MediaStreamTrack,
  ) {
    this.context = context;
    this.node = node;
    this.source = source;
    this.track = track;
  }

  /** Build the chain. Resolves `null` (and closes the context) when the
   *  worklet cannot load — the caller keeps the raw track. */
  static async create(
    raw: MediaStreamTrack,
    enabled: boolean,
    onLog?: (text: string) => void,
  ): Promise<Denoiser | null> {
    // 48 kHz fixed: Opus's supported set excludes 44.1 kHz, so the
    // publish capture would resample the destination track's rate to
    // 48 kHz anyway — do it once, here, in Web Audio.
    const context = new AudioContext({ latencyHint: "interactive", sampleRate: 48_000 });
    const url = URL.createObjectURL(
      new Blob([GATE_WORKLET_SOURCE], { type: "application/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(url);
    } catch (err) {
      onLog?.(`noise gate unavailable: ${String(err)}`);
      void context.close().catch(() => {});
      return null;
    }

    const source = context.createMediaStreamSource(new MediaStream([raw]));
    const gate = new AudioWorkletNode(context, GATE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { enabled },
    });
    const dest = context.createMediaStreamDestination();
    dest.channelCount = 1;
    dest.channelCountMode = "explicit";
    source.connect(gate);
    gate.connect(dest);
    const track = dest.stream.getAudioTracks()[0];
    if (!track) {
      onLog?.("noise gate produced no track");
      gate.disconnect();
      source.disconnect();
      void context.close().catch(() => {});
      return null;
    }

    // A context created before the page's first gesture starts suspended
    // (Chrome's autoplay policy). Walking into the call is usually the
    // gesture, and a live getUserMedia input is exempt in Chromium — but
    // a context that stays suspended delivers silence to the publisher,
    // so this resume is load-bearing, not cosmetic. The one-shot
    // listeners cover the late-gesture case.
    void context.resume().catch(() => {});
    const unlock = () => {
      void context.resume().catch(() => {});
      window.removeEventListener("click", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("click", unlock);
    window.addEventListener("keydown", unlock);

    return new Denoiser(context, gate, source, track);
  }

  /** Toggle the gate (the "Noise cancellation" item; the browser's own
   *  `noiseSuppression` constraint rides the raw track separately). */
  setEnabled(on: boolean): void {
    this.node.port.postMessage({ enabled: on });
  }

  /** Tear the chain down (call leave / mic swap). Idempotent. */
  stop(): void {
    try {
      this.node.disconnect();
      this.source.disconnect();
    } catch {
      // the context is already closing
    }
    void this.context.close().catch(() => {});
  }
}
