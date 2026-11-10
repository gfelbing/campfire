//! Local media capture (README §6.3).
//!
//! Capture is only requested when the user explicitly joins a call (or the
//! tab refreshes mid-call and the call survived) — the mic prompt never
//! appears on page load. There is no ICE/TURN: media transits the MoQ SFU
//! over the same QUIC connection as the rest of the app (docs/moq-sfu.md).

/**
 * Acquire local mic + camera. Audio always on while in a call; video is
 * requested at 720p (README §6.3) so the SFU uplink stays within budget.
 */
export async function getLocalMedia(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
  });
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
