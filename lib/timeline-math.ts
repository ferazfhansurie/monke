import type { TimelineClip } from "./types";

// One home for the trim/speed/duration relationship.
//
// Before speed existed, "how long is this clip" was just `trimOut - trimIn`,
// written out in fifteen places across the player, the timeline, the
// inspector, the chat context and the exporter. Speed breaks that identity —
// a 2x clip occupies half as much timeline as its source range — and any
// site that kept the old formula would silently desync playback from the
// timeline. So the rule lives here and everything calls it.

/** Playback multiplier: 1 = normal, 2 = twice as fast, 0.5 = half speed. */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

export function clipSpeed(clip: Pick<TimelineClip, "speed">): number {
  const s = clip.speed ?? 1;
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, s));
}

/** How much of the SOURCE the clip uses, in source seconds. */
export function sourceSpan(clip: Pick<TimelineClip, "trimIn" | "trimOut">): number {
  return Math.max(0, clip.trimOut - clip.trimIn);
}

/** How much TIMELINE the clip occupies — the number almost everything wants. */
export function clipDuration(clip: Pick<TimelineClip, "trimIn" | "trimOut" | "speed">): number {
  return sourceSpan(clip) / clipSpeed(clip);
}

/**
 * Where to seek the source, given how far into the clip's on-screen life we
 * are. At 2x, one second on the timeline consumes two seconds of source.
 */
export function sourceTimeAt(clip: Pick<TimelineClip, "trimIn" | "trimOut" | "speed">, elapsedOnTimeline: number): number {
  return clip.trimIn + Math.max(0, elapsedOnTimeline) * clipSpeed(clip);
}
