"use client";

import type { ClipGrade } from "./types";

// Colour grading that renders identically in the preview and the export.
//
// The compositing rules in lib/export.ts had to be reimplemented against
// canvas because the preview uses CSS — and that duplication is a standing
// risk of drift. Grading avoids repeating that mistake: canvas2d's
// `ctx.filter` accepts the same filter syntax as CSS, *including*
// `url(#svgFilterId)` references to an feColorMatrix (verified in Chrome:
// a matrix scaling R by 1.2 and B by 0.8 turned rgb(120,120,120) into
// [144,120,96] on canvas, exactly as in CSS). So both paths consume one
// filter string driving one filter — parity by construction.
//
// Everything lives inside ONE SVG filter, including brightness/contrast/
// saturation which CSS could express directly. That's deliberate: Chrome's
// canvas renders a filter list PURE BLACK when a CSS shorthand precedes a
// url() reference (verified — "brightness(1.2) url(#f)" gives [0,0,0] while
// either alone is correct, and reversing the order also works). Rather than
// depend on that ordering quirk, the filter string is only ever a single
// url(), so there is nothing to mix.

export const NEUTRAL_GRADE: Required<ClipGrade> = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  lift: 0,
};

export function hasGrade(grade: ClipGrade | undefined): grade is ClipGrade {
  if (!grade) return false;
  return (Object.keys(NEUTRAL_GRADE) as (keyof ClipGrade)[]).some((k) => (grade[k] ?? 0) !== 0);
}

// feColorMatrix rows are R,G,B,A each as (r g b a offset). Temperature warms
// by pushing red up and blue down (and the reverse for cool); tint trades
// green against magenta; lift is a flat offset, which is what raises or
// crushes the blacks.
export function gradeMatrixValues(grade: ClipGrade): string {
  const temp = grade.temperature ?? 0;
  const tint = grade.tint ?? 0;
  const lift = (grade.lift ?? 0) * 0.25; // full-scale lift would blow out instantly

  const r = 1 + temp * 0.3 + tint * 0.1;
  const g = 1 - tint * 0.2;
  const b = 1 - temp * 0.3 + tint * 0.1;

  return [
    `${r} 0 0 0 ${lift}`,
    `0 ${g} 0 0 ${lift}`,
    `0 0 ${b} 0 ${lift}`,
    `0 0 0 1 0`,
  ].join("  ");
}

const FILTER_HOST_ID = "monke-grade-filters";

/**
 * Creates or updates the SVG filter for a clip and returns its id. The SVG
 * lives in the document because canvas resolves `url(#id)` against the
 * document — the canvas itself doesn't need to be attached, but the filter
 * does.
 */
export function ensureGradeFilter(clipId: string, grade: ClipGrade): string {
  const filterId = `monke-grade-${clipId}`;
  if (typeof document === "undefined") return filterId;

  let host = document.getElementById(FILTER_HOST_ID) as SVGSVGElement | null;
  if (!host) {
    const svgNS = "http://www.w3.org/2000/svg";
    host = document.createElementNS(svgNS, "svg") as SVGSVGElement;
    host.id = FILTER_HOST_ID;
    host.setAttribute("aria-hidden", "true");
    // Zero-sized and out of flow: this element exists only to own filters.
    host.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
    document.body.appendChild(host);
  }

  const svgNS = "http://www.w3.org/2000/svg";
  let filter = document.getElementById(filterId) as SVGFilterElement | null;
  if (!filter) {
    filter = document.createElementNS(svgNS, "filter") as SVGFilterElement;
    filter.id = filterId;
    // Without sRGB the browser filters in linear space and the result
    // doesn't match what the same numbers do in CSS.
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const matrix = document.createElementNS(svgNS, "feColorMatrix");
    matrix.setAttribute("type", "matrix");
    filter.appendChild(matrix);
    host.appendChild(filter);
  }
  // Rebuild the primitive chain each time — grading is dragged in
  // real time, and reconciling in place is more code than recreating three
  // small nodes.
  while (filter.firstChild) filter.removeChild(filter.firstChild);

  // 1. Temperature / tint / lift.
  const matrix = document.createElementNS(svgNS, "feColorMatrix");
  matrix.setAttribute("type", "matrix");
  matrix.setAttribute("values", gradeMatrixValues(grade));
  filter.appendChild(matrix);

  // 2. Exposure and contrast as one linear transfer. CSS defines
  //    brightness(b) as out = b*in and contrast(c) as out = c*(in-0.5)+0.5;
  //    composing them gives slope = b*c, intercept = 0.5-0.5c, so this
  //    matches the CSS functions exactly rather than approximating them.
  const b = 1 + (grade.exposure ?? 0);
  const c = 1 + (grade.contrast ?? 0);
  if (b !== 1 || c !== 1) {
    const transfer = document.createElementNS(svgNS, "feComponentTransfer");
    for (const ch of ["feFuncR", "feFuncG", "feFuncB"]) {
      const fn = document.createElementNS(svgNS, ch);
      fn.setAttribute("type", "linear");
      fn.setAttribute("slope", String(b * c));
      fn.setAttribute("intercept", String(0.5 - 0.5 * c));
      transfer.appendChild(fn);
    }
    filter.appendChild(transfer);
  }

  // 3. Saturation — feColorMatrix type="saturate" is what CSS saturate()
  //    is defined in terms of, so this is the same operation, not a
  //    lookalike.
  const sat = 1 + (grade.saturation ?? 0);
  if (sat !== 1) {
    const satNode = document.createElementNS(svgNS, "feColorMatrix");
    satNode.setAttribute("type", "saturate");
    satNode.setAttribute("values", String(Math.max(0, sat)));
    filter.appendChild(satNode);
  }

  return filterId;
}

/**
 * The filter string for a clip, usable as either a CSS `filter` value or a
 * canvas2d `ctx.filter`. Returns undefined for a neutral grade so an
 * ungraded clip pays no filtering cost at all.
 */
export function gradeFilterString(clipId: string, grade: ClipGrade | undefined): string | undefined {
  if (!hasGrade(grade)) return undefined;
  return `url(#${ensureGradeFilter(clipId, grade)})`;
}
