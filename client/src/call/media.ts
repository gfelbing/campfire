//! Local media capture (README §6.3) and ICE server configuration (§6.2).
//!
//! Capture is only requested when the user explicitly joins a call (ringing
//! out or accepting a ring) — the mic prompt never appears on page load.

/**
 * Acquire local mic + camera. Audio always on while in a call; video is
 * requested at 720p (README §6.3) so the server relay cap and mesh uplink
 * stay within budget.
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

/** The TURN REST credential pair from the server (README §6.2). */
interface TurnCredential {
  username: string;
  credential: string;
  /** Unix seconds; the pair is good for one hour. */
  expires: number;
}

let cached: { servers: RTCIceServer[]; expires: number } | null = null;

/**
 * ICE servers for a call: the co-located STUN responder on 443/UDP plus the
 * `turns:` relay on 443/TCP (README §6.2). Credentials come from
 * `POST /api/v1/turn/credential` (1 h TTL, rate-limited per IP) and are
 * cached until close to expiry, so a burst of calls does not hammer the
 * rate limit.
 */
export async function iceServers(): Promise<RTCIceServer[]> {
  // Explicit port on both URLs: without one, browsers fall back to the RFC
  // defaults (3478 for STUN, 5349 for TURN) — campfire serves both on the
  // same 443 port as HTTPS/QUIC, and a `location.host` on the default port
  // carries no port suffix at all.
  const host = `${location.hostname}:${location.port || 443}`;
  const stun: RTCIceServer = { urls: `stun:${host}` };
  if (cached && Date.now() / 1000 < cached.expires - 60) return cached.servers;
  try {
    const res = await fetch("/api/v1/turn/credential", { method: "POST" });
    if (!res.ok) throw new Error(`turn credential: ${res.status}`);
    const cred = (await res.json()) as TurnCredential;
    const servers: RTCIceServer[] = [
      stun,
      { urls: `turns:${host}?transport=tcp`, username: cred.username, credential: cred.credential },
    ];
    cached = { servers, expires: cred.expires };
    return servers;
  } catch (err) {
    // The relay is a fallback tier: if credential minting fails, STUN-only
    // still works on open networks.
    console.warn("TURN credential unavailable, using STUN only:", err);
    return [stun];
  }
}
