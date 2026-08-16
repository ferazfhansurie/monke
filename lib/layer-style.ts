import type { CSSProperties } from "react";
import type { ClipMask, ClipRect, TimelineClip } from "./types";

export const FULL_FRAME: ClipRect = { x: 0, y: 0, width: 1, height: 1 };

// Sensible default box for a picture-in-picture overlay: bottom-right
// corner, roughly a third of the frame, clear of typical caption/UI areas.
export const DEFAULT_PIP_RECT: ClipRect = { x: 0.58, y: 0.58, width: 0.38, height: 0.38 };

function maskToClipPath(mask: ClipMask): string {
  const top = Math.max(0, Math.min(1, mask.insetTop)) * 100;
  const right = Math.max(0, Math.min(1, mask.insetRight)) * 100;
  const bottom = Math.max(0, Math.min(1, mask.insetBottom)) * 100;
  const left = Math.max(0, Math.min(1, mask.insetLeft)) * 100;
  if (mask.shape === "rect") {
    return `inset(${top}% ${right}% ${bottom}% ${left}%)`;
  }
  const rx = Math.max(0, (100 - left - right) / 2);
  const ry = Math.max(0, (100 - top - bottom) / 2);
  const cx = left + rx;
  const cy = top + ry;
  return `ellipse(${rx}% ${ry}% at ${cx}% ${cy}%)`;
}

// Position/opacity/mask -> absolute-positioned CSS for a clip rendered
// inside a relatively-positioned stage container. Shared by the base-track
// video slots and every overlay track's video elements, so a mask/position
// set on ANY clip (not just overlays) renders consistently.
export function clipLayerStyle(clip: Pick<TimelineClip, "position" | "opacity" | "mask" | "trackIndex">): CSSProperties {
  const rect = clip.position ?? FULL_FRAME;
  const style: CSSProperties = {
    position: "absolute",
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
    opacity: clip.opacity ?? 1,
    zIndex: clip.trackIndex ?? 0,
    objectFit: "cover",
  };
  if (clip.mask) style.clipPath = maskToClipPath(clip.mask);
  return style;
}
