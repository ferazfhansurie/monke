"use client";

import { useEffect, useRef, useState } from "react";
import { loadPeaks, getCachedPeaks, drawWaveform } from "@/lib/waveform";
import type { MediaItem } from "@/lib/types";

interface ClipWaveformProps {
  item: MediaItem;
  trimIn: number;
  trimOut: number;
  width: number;
  height: number;
  color?: string;
}

// Draws a clip's audio over its thumbnail. Decoding happens once per source
// (cached in lib/waveform.ts) and off the render path, so a timeline of many
// clips doesn't stall while peaks are computed — each clip simply renders
// without a waveform until its own data arrives.
export function ClipWaveform({ item, trimIn, trimOut, width, height, color = "rgba(255,255,255,0.55)" }: ClipWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(() => getCachedPeaks(item.id) ?? null);

  useEffect(() => {
    if (peaks) return;
    let cancelled = false;
    void loadPeaks(item).then((p) => {
      if (!cancelled && p) setPeaks(p);
    });
    return () => {
      cancelled = true;
    };
  }, [item, peaks]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    drawWaveform(canvas, peaks, trimIn, trimOut, item.durationSec ?? trimOut, color);
  }, [peaks, trimIn, trimOut, width, height, item.durationSec, color]);

  if (!peaks) return null;
  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-x-0 bottom-0" style={{ width, height }} aria-hidden="true" />;
}
