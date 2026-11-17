//! Local media capture (docs/arch/protocol.md).
//!
//! Capture is only requested when the user explicitly joins a call (or the
//! tab refreshes mid-call and the call survived) — the mic prompt never
//! appears on page load. There is no ICE/TURN: media transits the MoQ SFU
//! over the same QUIC connection as the rest of the app (docs/arch/moq-sfu.md).
//!
//! Device selection + audio processing preferences (the topbar's camera/mic
//! dropdowns) persist in localStorage and ride the constraints here.

/** Persisted media preferences (the topbar dropdowns' selections). */
export interface MediaPrefs {
  /** Chosen camera `deviceId`, or `undefined` for the OS default. */
  cameraId?: string;
  /** Chosen microphone `deviceId`, or `undefined` for the OS default. */
  micId?: string;
  /** Browser-side noise suppression on the mic track. Default: on. */
  noiseSuppression: boolean;
}

const STORAGE_KEY = "campfire.media";

/** Load the persisted preferences, tolerating garbage (private mode,
 *  schema drift): anything unreadable falls back to defaults. */
export function loadMediaPrefs(): MediaPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { noiseSuppression: true };
    const p = JSON.parse(raw) as Partial<MediaPrefs>;
    return {
      cameraId: typeof p.cameraId === "string" ? p.cameraId : undefined,
      micId: typeof p.micId === "string" ? p.micId : undefined,
      noiseSuppression: p.noiseSuppression !== false,
    };
  } catch {
    return { noiseSuppression: true };
  }
}

export function saveMediaPrefs(prefs: MediaPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // private mode etc.: the preference just does not persist
  }
}

/**
 * Acquire local mic + camera honoring `prefs` (device ids ride as
 * `ideal` constraints: a vanished device falls back to the OS default
 * instead of failing the join — the manager clears the stale id by
 * comparing the acquired track's actual device id). Audio always on
 * while in a call; video capped at 800x600 (issues.md #3) so the SFU
 * uplink stays within budget.
 */
export async function getLocalMedia(prefs: MediaPrefs): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: prefs.noiseSuppression,
      autoGainControl: true,
      ...(prefs.micId ? { deviceId: { ideal: prefs.micId } } : {}),
    },
    video: {
      width: { ideal: 800, max: 800 },
      height: { ideal: 600, max: 600 },
      frameRate: { ideal: 30, max: 30 },
      ...(prefs.cameraId ? { deviceId: { ideal: prefs.cameraId } } : {}),
    },
  });
  // Some cameras deliver 1280x720 despite the gUM `max` (the constraint is
  // advisory when the device can't comply). Re-apply it on the live track:
  // if the camera still refuses, the encoder's 480x360 pixel budget is the
  // last resort (a 16:9 frame then lands just under 800 wide, e.g. 912x512
  // from 1280x720).
  const video = stream.getVideoTracks()[0];
  if (video) {
    try {
      await video.applyConstraints({
        width: { max: 800 },
        height: { max: 600 },
        frameRate: { max: 30 },
      });
    } catch (e) {
      console.warn("video resolution cap rejected:", e);
    }
  }
  return stream;
}

/** Acquire the user's screen (or window/tab) for screen sharing (README
 *  roadmap "UI redesign"): the video track rides the uplink's `s`
 *  rendition. */
export async function getScreenMedia(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 15, max: 30 } },
    audio: false,
  });
}
