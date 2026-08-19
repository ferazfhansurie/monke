"use client";

import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { Caption, MediaItem, Timeline, ProjectSettings, TimelineClip } from "./types";
import { FULL_FRAME } from "./layer-style";
import { clipDuration, sourceSpan, sourceTimeAt, clipSpeed } from "./timeline-math";
import type { CutoutResult } from "./segmentation";

// Renders the timeline to a real MP4, entirely in the browser — no upload,
// no server, no cost, same local-first promise as the rest of MONKe.
//
// The preview composites with CSS (position/opacity/clip-path/mask-image on
// stacked <video> elements). Canvas can't reuse that, so this reimplements
// the same rules against a 2D context. Anything that changes in
// lib/layer-style.ts has to change here too — that duplication is the price
// of the preview being live DOM rather than a canvas.

// H.264 *High* profile specifically: tested in Chrome, Baseline
// (avc1.42E01E) and Main (avc1.4D401F) both report unsupported while High
// encodes on hardware and software. WebCodecs also only exists in a secure
// context, so this whole path silently vanishes on plain http.
const H264_HIGH = "avc1.640028";
const AAC = "mp4a.40.2";

export interface ExportProgress {
  phase: "preparing" | "rendering" | "encoding-audio" | "finalizing";
  /** 0-1, or null while indeterminate. */
  progress: number | null;
  message: string;
}

export interface ExportOptions {
  timeline: Timeline;
  items: MediaItem[];
  settings: ProjectSettings;
  cutoutFrames: Record<string, CutoutResult>;
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
}

export async function isExportSupported(): Promise<{ ok: boolean; reason?: string }> {
  if (typeof VideoEncoder === "undefined") {
    return { ok: false, reason: "This browser has no WebCodecs support. Chrome or Edge can export; Safari and Firefox can't yet." };
  }
  try {
    const support = await VideoEncoder.isConfigSupported({ codec: H264_HIGH, width: 1080, height: 1920, bitrate: 8_000_000, framerate: 30 });
    if (!support.supported) return { ok: false, reason: "This browser can't encode H.264 video." };
  } catch {
    return { ok: false, reason: "This browser can't encode H.264 video." };
  }
  return { ok: true };
}

interface BaseSlot {
  clip: TimelineClip;
  item: MediaItem;
  startOffset: number;
  duration: number;
}

// Base-track clips play back-to-back; overlays float at their own
// timelineStart. Mirrors resolveClips in lib/timeline-player.ts.
function layoutBase(timeline: Timeline, items: MediaItem[]): BaseSlot[] {
  const out: BaseSlot[] = [];
  let offset = 0;
  for (const clip of timeline.clips.filter((c) => (c.trackIndex ?? 0) === 0).sort((a, b) => a.order - b.order)) {
    const duration = clipDuration(clip);
    if (duration <= 0) continue;
    const item = items.find((i) => i.id === clip.mediaId);
    if (item) out.push({ clip, item, startOffset: offset, duration });
    offset += duration;
  }
  return out;
}

function overlaysAt(timeline: Timeline, t: number): TimelineClip[] {
  return timeline.clips
    .filter((c) => (c.trackIndex ?? 0) > 0)
    .filter((c) => {
      const start = c.timelineStart ?? 0;
      return t >= start && t < start + clipDuration(c);
    })
    .sort((a, b) => (a.trackIndex ?? 0) - (b.trackIndex ?? 0));
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", () => reject(new Error("Seek failed during export")), { once: true });
    video.currentTime = Math.max(0, time);
  });
}

async function videoFor(item: MediaItem, cache: Map<string, HTMLVideoElement>): Promise<HTMLVideoElement> {
  const existing = cache.get(item.id);
  if (existing) return existing;
  const file = await item.handle.getFile();
  const el = document.createElement("video");
  el.preload = "auto";
  el.muted = true;
  el.playsInline = true;
  el.src = URL.createObjectURL(file);
  await new Promise<void>((resolve, reject) => {
    el.onloadedmetadata = () => resolve();
    el.onerror = () => reject(new Error(`Couldn't read ${item.name} for export`));
  });
  cache.set(item.id, el);
  return el;
}

// Draws one source into its destination rect, applying the same
// position/opacity/mask/cutout rules the preview applies via CSS.
function drawLayer(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  clip: TimelineClip,
  W: number,
  H: number,
  cutoutFrame: HTMLImageElement | null,
  scratch: HTMLCanvasElement
) {
  const rect = clip.position ?? FULL_FRAME;
  const dx = rect.x * W;
  const dy = rect.y * H;
  const dw = rect.width * W;
  const dh = rect.height * H;

  ctx.save();
  ctx.globalAlpha = clip.opacity ?? 1;

  if (clip.mask) {
    // clip-path inset/ellipse are fractions of the clip's OWN box.
    const { insetTop: t, insetRight: r, insetBottom: b, insetLeft: l, shape } = clip.mask;
    const mx = dx + l * dw;
    const my = dy + t * dh;
    const mw = Math.max(0, dw - (l + r) * dw);
    const mh = Math.max(0, dh - (t + b) * dh);
    ctx.beginPath();
    if (shape === "ellipse") ctx.ellipse(mx + mw / 2, my + mh / 2, mw / 2, mh / 2, 0, 0, Math.PI * 2);
    else ctx.rect(mx, my, mw, mh);
    ctx.clip();
  }

  if (cutoutFrame) {
    // The matte is luminance (white = keep). Composite on a scratch canvas
    // first — destination-in against the main canvas would erase whatever
    // is already composited underneath.
    scratch.width = Math.max(1, Math.round(dw));
    scratch.height = Math.max(1, Math.round(dh));
    const sctx = scratch.getContext("2d");
    if (sctx) {
      sctx.clearRect(0, 0, scratch.width, scratch.height);
      sctx.globalCompositeOperation = "source-over";
      sctx.drawImage(source, 0, 0, scratch.width, scratch.height);
      sctx.globalCompositeOperation = "destination-in";
      sctx.drawImage(cutoutFrame, 0, 0, scratch.width, scratch.height);
      sctx.globalCompositeOperation = "source-over";
      ctx.drawImage(scratch, dx, dy, dw, dh);
    }
  } else {
    ctx.drawImage(source, dx, dy, dw, dh);
  }

  ctx.restore();
}

function drawCaptions(ctx: CanvasRenderingContext2D, captions: Caption[], t: number, W: number, H: number) {
  for (const c of captions.filter((c) => t >= c.start && t < c.end)) {
    const scale = W / 1080; // captions are authored against a 1080-wide reference
    const size = c.fontSize * scale;
    ctx.save();
    ctx.font = `${c.bold ? 700 : 400} ${size}px "${c.fontFamily}", sans-serif`;
    ctx.fillStyle = c.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const boxX = c.position.x * W;
    const boxY = c.position.y * H;
    const boxW = c.position.width * W;
    const boxH = c.position.height * H;

    // Wrap to the caption's box rather than letting long lines run off frame.
    const words = c.text.split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width > boxW && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);

    const lineHeight = size * 1.25;
    const totalH = lines.length * lineHeight;
    let y = boxY + boxH / 2 - totalH / 2 + lineHeight / 2;
    for (const l of lines) {
      if (c.outline !== false) {
        ctx.lineWidth = Math.max(2, size * 0.08);
        ctx.strokeStyle = "rgba(0,0,0,0.9)";
        ctx.lineJoin = "round";
        ctx.strokeText(l, boxX + boxW / 2, y);
      }
      ctx.fillText(l, boxX + boxW / 2, y);
      y += lineHeight;
    }
    ctx.restore();
  }
}

// Mixes every clip's audio into one buffer, honouring per-clip volume and
// mute and each clip's position on the master clock.
async function mixAudio(timeline: Timeline, items: MediaItem[], totalDuration: number, signal?: AbortSignal): Promise<AudioBuffer | null> {
  const sampleRate = 48000;
  const frames = Math.ceil(totalDuration * sampleRate);
  if (frames <= 0) return null;

  const base = layoutBase(timeline, items);
  const placements: { item: MediaItem; at: number; trimIn: number; trimOut: number; volume: number; speed: number; fadeIn: number; fadeOut: number; onTimeline: number }[] = [];
  for (const slot of base) {
    if (slot.clip.muted) continue;
    placements.push({ item: slot.item, at: slot.startOffset, trimIn: slot.clip.trimIn, trimOut: slot.clip.trimOut, volume: slot.clip.volume ?? 1, speed: clipSpeed(slot.clip), fadeIn: slot.clip.fadeInSec ?? 0, fadeOut: slot.clip.fadeOutSec ?? 0, onTimeline: clipDuration(slot.clip) });
  }
  for (const clip of timeline.clips.filter((c) => (c.trackIndex ?? 0) > 0)) {
    // Overlays default to muted — only include one that was explicitly unmuted.
    if (clip.muted !== false) continue;
    const item = items.find((i) => i.id === clip.mediaId);
    if (item) placements.push({ item, at: clip.timelineStart ?? 0, trimIn: clip.trimIn, trimOut: clip.trimOut, volume: clip.volume ?? 1, speed: clipSpeed(clip), fadeIn: clip.fadeInSec ?? 0, fadeOut: clip.fadeOutSec ?? 0, onTimeline: clipDuration(clip) });
  }
  if (placements.length === 0) return null;

  const offline = new OfflineAudioContext(2, frames, sampleRate);
  for (const p of placements) {
    if (signal?.aborted) throw new Error("Export cancelled");
    try {
      const buf = await offline.decodeAudioData(await (await p.item.handle.getFile()).arrayBuffer());
      const src = offline.createBufferSource();
      src.buffer = buf;
      const gain = offline.createGain();
      // Scheduled on the offline timeline rather than sampled per frame:
      // the graph resolves ramps at full audio rate, so a fade is smooth
      // regardless of the video frame rate.
      const fadeIn = Math.max(0, Math.min(p.fadeIn, p.onTimeline));
      const fadeOut = Math.max(0, Math.min(p.fadeOut, p.onTimeline));
      gain.gain.setValueAtTime(fadeIn > 0 ? 0 : p.volume, p.at);
      if (fadeIn > 0) gain.gain.linearRampToValueAtTime(p.volume, p.at + fadeIn);
      if (fadeOut > 0) {
        gain.gain.setValueAtTime(p.volume, Math.max(p.at, p.at + p.onTimeline - fadeOut));
        gain.gain.linearRampToValueAtTime(0, p.at + p.onTimeline);
      }
      src.playbackRate.value = p.speed;
      src.connect(gain).connect(offline.destination);
      // offset/duration are in SOURCE seconds; playbackRate is what makes
      // that span land in the right amount of timeline.
      src.start(p.at, p.trimIn, sourceSpan(p));
    } catch {
      // A clip with no audio track (or an undecodable one) simply
      // contributes silence rather than failing the whole export.
    }
  }
  return offline.startRendering();
}

export async function exportTimeline(opts: ExportOptions): Promise<Blob> {
  const { timeline, items, settings, cutoutFrames, onProgress, signal } = opts;
  const report = (p: ExportProgress) => onProgress?.(p);

  report({ phase: "preparing", progress: null, message: "Preparing…" });

  const base = layoutBase(timeline, items);
  if (base.length === 0) throw new Error("Nothing on the timeline to export.");
  const totalDuration = base[base.length - 1].startOffset + base[base.length - 1].duration;

  // Even dimensions — H.264 requires it and odd values fail at configure().
  const W = Math.round(settings.resolutionW / 2) * 2;
  const H = Math.round(settings.resolutionH / 2) * 2;
  const fps = settings.frameRate || 30;
  const totalFrames = Math.max(1, Math.round(totalDuration * fps));

  const audio = await mixAudio(timeline, items, totalDuration, signal);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H },
    ...(audio ? { audio: { codec: "aac", sampleRate: audio.sampleRate, numberOfChannels: 2 } } : {}),
    fastStart: "in-memory", // so the file is playable/seekable immediately
  });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      throw e;
    },
  });
  videoEncoder.configure({
    codec: H264_HIGH,
    width: W,
    height: H,
    // ~0.12 bits per pixel per frame: sane quality for social delivery
    // without producing a file too large to upload.
    bitrate: Math.round(W * H * fps * 0.12),
    framerate: fps,
  });

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas unavailable");
  const scratch = document.createElement("canvas");

  const videoCache = new Map<string, HTMLVideoElement>();
  const cutoutImgCache = new Map<string, HTMLImageElement[]>();

  const loadCutoutFrames = async (clipId: string): Promise<HTMLImageElement[] | null> => {
    const result = cutoutFrames[clipId];
    if (!result) return null;
    const cached = cutoutImgCache.get(clipId);
    if (cached) return cached;
    const imgs = await Promise.all(
      result.frameUrls.map(
        (url) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("Couldn't load a cutout frame"));
            img.src = url;
          })
      )
    );
    cutoutImgCache.set(clipId, imgs);
    return imgs;
  };

  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      if (signal?.aborted) throw new Error("Export cancelled");
      const t = frame / fps;

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);

      const slot = base.find((s) => t >= s.startOffset && t < s.startOffset + s.duration) ?? base[base.length - 1];
      if (slot) {
        const video = await videoFor(slot.item, videoCache);
        await seekTo(video, sourceTimeAt(slot.clip, t - slot.startOffset));
        const frames = await loadCutoutFrames(slot.clip.id);
        const cutout = frames && cutoutFrames[slot.clip.id]
          ? frames[Math.min(frames.length - 1, Math.floor((t - slot.startOffset) * cutoutFrames[slot.clip.id].fps))] ?? null
          : null;
        drawLayer(ctx, video, slot.clip, W, H, cutout, scratch);
      }

      for (const clip of overlaysAt(timeline, t)) {
        const item = items.find((i) => i.id === clip.mediaId);
        if (!item) continue;
        const elapsed = t - (clip.timelineStart ?? 0);
        const video = await videoFor(item, videoCache);
        await seekTo(video, sourceTimeAt(clip, elapsed));
        const frames = await loadCutoutFrames(clip.id);
        const cutout = frames && cutoutFrames[clip.id]
          ? frames[Math.min(frames.length - 1, Math.floor(elapsed * cutoutFrames[clip.id].fps))] ?? null
          : null;
        drawLayer(ctx, video, clip, W, H, cutout, scratch);
      }

      drawCaptions(ctx, timeline.captions, t, W, H);

      const vf = new VideoFrame(canvas, { timestamp: Math.round((frame * 1_000_000) / fps), duration: Math.round(1_000_000 / fps) });
      // Keyframe every 2s so the result seeks properly in players/uploaders.
      videoEncoder.encode(vf, { keyFrame: frame % (fps * 2) === 0 });
      vf.close();

      // Don't let the encoder queue outrun memory on a long timeline.
      if (videoEncoder.encodeQueueSize > 8) await videoEncoder.flush();

      if (frame % 5 === 0 || frame === totalFrames - 1) {
        report({
          phase: "rendering",
          progress: (frame + 1) / totalFrames,
          message: `Rendering frame ${frame + 1} of ${totalFrames}`,
        });
      }
    }

    await videoEncoder.flush();

    if (audio) {
      report({ phase: "encoding-audio", progress: null, message: "Encoding audio…" });
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => {
          throw e;
        },
      });
      audioEncoder.configure({ codec: AAC, sampleRate: audio.sampleRate, numberOfChannels: 2, bitrate: 128_000 });

      // Interleave the planar channels — AudioData wants f32-planar laid out
      // channel after channel, not sample-interleaved.
      const CHUNK = 48000;
      const left = audio.getChannelData(0);
      const right = audio.numberOfChannels > 1 ? audio.getChannelData(1) : left;
      for (let offset = 0; offset < audio.length; offset += CHUNK) {
        if (signal?.aborted) throw new Error("Export cancelled");
        const count = Math.min(CHUNK, audio.length - offset);
        const planar = new Float32Array(count * 2);
        planar.set(left.subarray(offset, offset + count), 0);
        planar.set(right.subarray(offset, offset + count), count);
        const data = new AudioData({
          format: "f32-planar",
          sampleRate: audio.sampleRate,
          numberOfFrames: count,
          numberOfChannels: 2,
          timestamp: Math.round((offset / audio.sampleRate) * 1_000_000),
          data: planar,
        });
        audioEncoder.encode(data);
        data.close();
      }
      await audioEncoder.flush();
      audioEncoder.close();
    }

    report({ phase: "finalizing", progress: null, message: "Writing file…" });
    muxer.finalize();
    const { buffer } = muxer.target as ArrayBufferTarget;
    return new Blob([buffer], { type: "video/mp4" });
  } finally {
    if (videoEncoder.state !== "closed") videoEncoder.close();
    for (const el of videoCache.values()) URL.revokeObjectURL(el.src);
  }
}
