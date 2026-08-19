"use client";

import type { MediaItem } from "./types";

// Peak data for drawing an audio waveform on a timeline clip. Cutting
// dialogue accurately is guesswork without seeing where sound actually is —
// this is what turns "trim by eye and re-listen" into "trim to the gap
// between words".
//
// Peaks are computed once per media item over the WHOLE source, in
// normalized 0-1 positions, so any trimmed range can be sliced out of them
// without re-decoding. The array is a few thousand floats — small enough to
// cache unbounded, unlike the raw PCM in lib/audio.ts (which is megabytes
// per minute and is deliberately capped).

const PEAKS_PER_SOURCE = 2000;

const peakCache = new Map<string, Float32Array>();
const inFlight = new Map<string, Promise<Float32Array | null>>();

async function computePeaks(item: MediaItem): Promise<Float32Array | null> {
  try {
    const file = await item.handle.getFile();
    const arrayBuffer = await file.arrayBuffer();
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    let decoded: AudioBuffer;
    try {
      decoded = await ctx.decodeAudioData(arrayBuffer);
    } finally {
      void ctx.close();
    }

    const channel = decoded.getChannelData(0);
    const bucketSize = Math.max(1, Math.floor(channel.length / PEAKS_PER_SOURCE));
    const peaks = new Float32Array(PEAKS_PER_SOURCE);
    let max = 0;
    for (let i = 0; i < PEAKS_PER_SOURCE; i++) {
      const start = i * bucketSize;
      const end = Math.min(channel.length, start + bucketSize);
      let peak = 0;
      // Stride rather than reading every sample: at 48kHz a bucket can be
      // thousands of samples and the visual result is identical.
      for (let j = start; j < end; j += 8) {
        const v = Math.abs(channel[j]);
        if (v > peak) peak = v;
      }
      peaks[i] = peak;
      if (peak > max) max = peak;
    }
    // Normalize so quiet recordings are still readable, not a flat line.
    if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
    return peaks;
  } catch {
    // No audio track, or a format the browser can't decode — the clip just
    // renders without a waveform rather than the timeline erroring.
    return null;
  }
}

export function getCachedPeaks(mediaId: string): Float32Array | undefined {
  return peakCache.get(mediaId);
}

// Deduplicated: several clips can share one source, and the timeline may ask
// for the same item on every render.
export async function loadPeaks(item: MediaItem): Promise<Float32Array | null> {
  const cached = peakCache.get(item.id);
  if (cached) return cached;
  const running = inFlight.get(item.id);
  if (running) return running;

  const promise = computePeaks(item).then((peaks) => {
    if (peaks) peakCache.set(item.id, peaks);
    inFlight.delete(item.id);
    return peaks;
  });
  inFlight.set(item.id, promise);
  return promise;
}

// Slices the source-wide peaks down to a clip's trimmed range and paints
// them symmetrically around the vertical centre.
export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  trimIn: number,
  trimOut: number,
  sourceDuration: number,
  color: string
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx || sourceDuration <= 0) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  const from = Math.max(0, Math.min(1, trimIn / sourceDuration)) * peaks.length;
  const to = Math.max(0, Math.min(1, trimOut / sourceDuration)) * peaks.length;
  const span = Math.max(1, to - from);
  const mid = height / 2;

  ctx.fillStyle = color;
  for (let x = 0; x < width; x++) {
    const idx = Math.floor(from + (x / width) * span);
    const peak = peaks[Math.min(peaks.length - 1, Math.max(0, idx))] ?? 0;
    const h = Math.max(1, peak * mid);
    ctx.fillRect(x, mid - h, 1, h * 2);
  }
}
