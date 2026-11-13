//! Local media capture (README §6.3).
//!
//! Capture is only requested when the user explicitly joins a call (or the
//! tab refreshes mid-call and the call survived) — the mic prompt never
//! appears on page load. There is no ICE/TURN: media transits the MoQ SFU
//! over the same QUIC connection as the rest of the app (docs/moq-sfu.md).

/**
 * Acquire local mic + camera. Audio always on while in a call; video is
 * capped at 800x600 (issues.md #3) so the SFU uplink stays within budget.
 */
export async function getLocalMedia(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: {
      width: { ideal: 800, max: 800 },
      height: { ideal: 600, max: 600 },
      frameRate: { ideal: 30, max: 30 },
    },
  });
  // Some cameras deliver 1280x720 despite the gUM `max` (the constraint is
  // advisory when the device can't comply). Re-apply it on the live track:
  // if the camera still refuses, the encoder's 800x600 pixel budget is the
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
    console.log("video capture settings:", JSON.stringify(video.getSettings()));
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
