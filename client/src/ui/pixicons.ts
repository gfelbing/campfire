// Pixel-art icon set (README roadmap): the UI's functional icons come
// from the `pixelarticons` package (MIT, halfmage) — the same visual
// language as the character avatars, drawn properly. Only the icons the
// UI needs are imported (Vite `?raw` inlines the SVG source, so the
// bundle carries six small strings, not the 460-icon set).
//
// SVGs draw with `fill="currentColor"`, so button/badge styling colors
// them like text.

import micRaw from "pixelarticons/svg/mic.svg?raw";
import micOffRaw from "pixelarticons/svg/mic-off.svg?raw";
import videoRaw from "pixelarticons/svg/video.svg?raw";
import monitorRaw from "pixelarticons/svg/monitor.svg?raw";
import headphoneRaw from "pixelarticons/svg/headphone.svg?raw";
import phoneRaw from "pixelarticons/svg/phone.svg?raw";
import usersRaw from "pixelarticons/svg/users.svg?raw";
import messageTextRaw from "pixelarticons/svg/message-text.svg?raw";
import messageReplyRaw from "pixelarticons/svg/message-reply.svg?raw";

export type IconName =
  | "mic"
  | "mic-off"
  | "camera"
  | "screen"
  | "hangup"
  | "headphones"
  | "users"
  | "message-text"
  | "message-reply";

const RAW: Record<IconName, string> = {
  mic: micRaw,
  "mic-off": micOffRaw,
  camera: videoRaw,
  screen: monitorRaw,
  hangup: phoneRaw,
  headphones: headphoneRaw,
  users: usersRaw,
  "message-text": messageTextRaw,
  "message-reply": messageReplyRaw,
};

/** The icon as a fresh `<svg>` element (DOM buttons and badges). */
export function iconNode(name: IconName, size = 24): SVGSVGElement {
  const t = document.createElement("template");
  t.innerHTML = RAW[name]!.trim();
  const el = t.content.firstElementChild as SVGSVGElement;
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  return el;
}

/** The icon rasterized onto a canvas (Pixi sprites — the avatar's
 *  in-call badge). Pixel-art paths are axis-aligned rects, so integer
 *  raster sizes stay crisp. */
export async function iconCanvas(
  name: IconName,
  size = 24,
): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = `data:image/svg+xml;base64,${btoa(RAW[name]!)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  canvas.getContext("2d")!.drawImage(img, 0, 0, size, size);
  return canvas;
}
