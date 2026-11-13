//! Bubble notification sounds (README §11 acceptance, issues.md): a short
//! "bing" when we enter a bubble and a "bong" when we leave it.
//!
//! Synthesized with WebAudio — no asset to ship or load. The AudioContext
//! is created lazily on the first sound; by then the user has joined the
//! page (a user gesture), so autoplay policy allows it. Any failure
//! (headless without audio, blocked context) is silent by design: a
//! notification sound must never break the call.

let ctx: AudioContext | null = null;

/** Lazily create (and resume) the shared AudioContext. */
function audio(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One sine tone with a fast attack and exponential decay. */
function tone(ac: AudioContext, freq: number, at: number, dur: number, peak: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

export type CallSound = "enter" | "leave";

/** Enter: two rising notes (D5 → A5). Leave: the reverse, a step lower. */
export function playCallSound(kind: CallSound): void {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + 0.02;
  if (kind === "enter") {
    tone(ac, 587.33, t, 0.18, 0.06);
    tone(ac, 880.0, t + 0.12, 0.3, 0.08);
  } else {
    tone(ac, 880.0, t, 0.18, 0.06);
    tone(ac, 523.25, t + 0.12, 0.3, 0.08);
  }
}

/** A short "blob" for an incoming chat message: one sine blip sliding
 *  down (320 → 140 Hz), the classic water-drop shape. */
export function playBlob(): void {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + 0.02;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(320, t);
  osc.frequency.exponentialRampToValueAtTime(140, t + 0.12);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.08, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  osc.connect(gain).connect(ac.destination);
  osc.start(t);
  osc.stop(t + 0.25);
}
