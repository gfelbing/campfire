// Keyboard state: WASD + arrows, Shift to run.

export interface KeyState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  run: boolean;
}

export const keys: KeyState = {
  up: false,
  down: false,
  left: false,
  right: false,
  run: false,
};

const MAP: Record<string, keyof KeyState> = {
  KeyW: "up",
  ArrowUp: "up",
  KeyS: "down",
  ArrowDown: "down",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  ShiftLeft: "run",
  ShiftRight: "run",
};

let attached = false;

/** True when the event target is a text-entry element: typing WASD in the
 *  profile form (issues.md #5) must not drive movement. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

/** Attach keyboard listeners once (movement keys are the only ones we eat). */
export function attachKeys(): void {
  if (attached) return;
  attached = true;
  window.addEventListener("keydown", (e) => {
    const k = MAP[e.code];
    if (!k || isTypingTarget(e.target)) return;
    keys[k] = true;
    if (k !== "run") e.preventDefault();
  });
  window.addEventListener("keyup", (e) => {
    const k = MAP[e.code];
    if (!k || isTypingTarget(e.target)) return;
    keys[k] = false;
  });
  window.addEventListener("blur", () => {
    keys.up = keys.down = keys.left = keys.right = keys.run = false;
  });
}

/** Desired velocity in tiles/s from the key state (walk 4, run 8 — README §5). */
export function desiredVelocity(dtTiles: number): { vx: number; vy: number; moving: boolean } {
  const vx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const vy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  if (vx === 0 && vy === 0) return { vx: 0, vy: 0, moving: false };
  const len = Math.hypot(vx, vy);
  const speed = keys.run ? 8 : 4;
  const step = (speed * dtTiles) / len;
  return { vx: vx * step, vy: vy * step, moving: true };
}
