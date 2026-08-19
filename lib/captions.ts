import type { Caption } from "./types";

// Caption behaviour shared by the preview (DOM) and the exporter (canvas).
// Both paths import from here rather than each implementing the rules, for
// the same reason grading uses one filter: two implementations drift.

/** 0-1 opacity at a master-clock time, applying the caption's fade. */
export function captionOpacityAt(caption: Caption, t: number): number {
  const fade = Math.max(0, caption.fadeSec ?? 0);
  if (fade <= 0) return 1;
  const dur = Math.max(0, caption.end - caption.start);
  if (dur <= 0) return 1;
  const into = t - caption.start;
  // Clamp so a fade longer than the caption can't invert.
  const f = Math.min(fade, dur / 2);
  if (into < f) return Math.max(0, into / f);
  if (into > dur - f) return Math.max(0, (dur - into) / f);
  return 1;
}

export type CaptionStyleKind = "subtitle" | "band" | "title";

/** The looks people actually ask for, as concrete field values. */
export function captionStyle(kind: CaptionStyleKind): Partial<Caption> {
  switch (kind) {
    case "subtitle":
      // Plain outlined text, no box — reads over almost any footage.
      return { background: undefined, outline: true, fontSize: 64, bold: true, position: { x: 0.05, y: 0.78, width: 0.9, height: 0.15 } };
    case "band":
      // Dark band behind the text, for busy or bright backgrounds.
      return { background: "rgba(0,0,0,0.62)", backgroundRadius: 16, outline: false, fontSize: 60, bold: true, position: { x: 0.06, y: 0.76, width: 0.88, height: 0.14 } };
    case "title":
      // Full-frame card — a hook or CTA moment rather than dialogue.
      return { background: "rgba(0,0,0,0.82)", backgroundRadius: 0, outline: false, fontSize: 96, bold: true, position: { x: 0, y: 0, width: 1, height: 1 } };
  }
}
