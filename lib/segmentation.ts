"use client";

import * as ort from "onnxruntime-web";
import type { MediaItem } from "./types";

// Person cutout (background removal) via Robust Video Matting (RVM) —
// https://github.com/PeterL1n/RobustVideoMatting, licensed GPL-3.0 (a
// known, deliberate choice — see public/models/LICENSE-rvm.txt). Runs
// entirely in-browser via ONNX Runtime Web/WASM, same local-first promise
// as the rest of MONKe's AI tooling: footage never leaves the browser.
//
// Unlike a single-image segmentation model, RVM is a recurrent network —
// each frame's inference both consumes AND produces 4 "hidden state"
// tensors (r1-r4) that carry temporal context frame-to-frame, which is
// what gives it soft, stable edges (hair, motion blur) instead of a
// flickering per-frame silhouette. This means frames MUST be processed
// strictly in order, never in parallel, and the recurrent state from frame
// N feeds frame N+1.
const MODEL_URL = "/models/rvm_mobilenetv3_fp32.onnx";

// GitHub's release-asset CDN (where the model itself would otherwise load
// from) sends no CORS headers, so it's self-hosted in /public instead —
// but onnxruntime-web's own WASM runtime binaries still need a CORS-enabled
// source. jsdelivr is what @huggingface/transformers already falls back to
// for the exact same reason (proven working via the Whisper integration) —
// set explicitly here rather than relying on that fallback having already
// run this session.
const ORT_VERSION = "1.26.0-dev.20260416-b7804b056c";
if (!ort.env.wasm.wasmPaths) {
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
}

type CutoutStatusListener = (message: string | null) => void;
const cutoutStatusListeners = new Set<CutoutStatusListener>();

export function subscribeCutoutStatus(listener: CutoutStatusListener): () => void {
  cutoutStatusListeners.add(listener);
  return () => cutoutStatusListeners.delete(listener);
}

function setCutoutStatus(message: string | null) {
  for (const listener of cutoutStatusListeners) listener(message);
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;
function getRvmSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    setCutoutStatus("Loading cutout model…");
    sessionPromise = ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"] }).catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

export interface CutoutResult {
  // Alpha-only frames (white = keep, black = cut), as PNG data URLs — used
  // directly as a CSS mask-image over the clip's own <video> element, so
  // its native pixels show through the matte rather than needing a second
  // copy of the RGB data.
  dataUrls: string[];
  fps: number;
}

// Feeding RVM at full source resolution (verified fine for a one-off Node
// test) would be needlessly slow in-browser WASM on every sampled frame —
// downscale the working frame first. RVM's own encoder downsamples
// internally anyway (via downsample_ratio below); this just avoids paying
// full-resolution canvas/tensor-conversion cost on every single frame for
// detail the model would discard regardless. The output alpha is used as a
// CSS mask, which doesn't need to be pixel-exact to the source resolution.
const MAX_WORKING_DIM = 960;
const DOWNSAMPLE_RATIO = 0.25;

function drawScaledFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): { width: number; height: number } {
  const scale = Math.min(1, MAX_WORKING_DIM / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(2, Math.round(video.videoWidth * scale));
  const height = Math.max(2, Math.round(video.videoHeight * scale));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(video, 0, 0, width, height);
  return { width, height };
}

function frameToTensor(ctx: CanvasRenderingContext2D, width: number, height: number): ort.Tensor {
  const { data } = ctx.getImageData(0, 0, width, height);
  const chw = new Float32Array(3 * width * height);
  const hw = width * height;
  for (let i = 0; i < hw; i++) {
    chw[i] = data[i * 4] / 255;
    chw[hw + i] = data[i * 4 + 1] / 255;
    chw[2 * hw + i] = data[i * 4 + 2] / 255;
  }
  return new ort.Tensor("float32", chw, [1, 3, height, width]);
}

function alphaToDataUrl(pha: ort.Tensor, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  const imageData = ctx.createImageData(width, height);
  const phaData = pha.data as Float32Array;
  for (let i = 0; i < width * height; i++) {
    const v = Math.max(0, Math.min(255, Math.round(phaData[i] * 255)));
    imageData.data[i * 4] = v;
    imageData.data[i * 4 + 1] = v;
    imageData.data[i * 4 + 2] = v;
    imageData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

function zeroRecurrentState(): ort.Tensor[] {
  return [0, 0, 0, 0].map(() => new ort.Tensor("float32", new Float32Array([0]), [1, 1, 1, 1]));
}

// Bakes a person-cutout alpha matte for [startSec, endSec) of an item's
// video, sampled at sampleFps (capped well below typical source frame
// rates — see MAX_WORKING_DIM comment; this is a "bake once, reuse many"
// operation, not a real-time effect). Frames are processed strictly in
// order on a single video element seeked sequentially — required for
// RVM's recurrent state to actually track anything.
export async function bakeCutout(item: MediaItem, startSec: number, endSec: number, sampleFps = 10): Promise<CutoutResult> {
  const file = await item.handle.getFile();
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Couldn't read video for cutout"));
    });

    const session = await getRvmSession();
    const canvas = document.createElement("canvas");
    // willReadFrequently: every sampled frame calls getImageData on this
    // same canvas (frameToTensor) — without this hint the browser optimizes
    // for GPU-composited drawing instead, which is slower for the
    // read-heavy pattern this loop actually does (confirmed via a real
    // browser's own console warning during testing).
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas unavailable");

    const duration = Math.max(0, endSec - startSec);
    const frameCount = Math.max(1, Math.round(duration * sampleFps));
    const downsampleRatio = new ort.Tensor("float32", new Float32Array([DOWNSAMPLE_RATIO]), [1]);
    let rec = zeroRecurrentState();
    const dataUrls: string[] = [];

    for (let i = 0; i < frameCount; i++) {
      const t = Math.min(endSec - 0.02, startSec + i / sampleFps);
      await new Promise<void>((resolve, reject) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked);
        video.addEventListener("error", () => reject(new Error("Seek failed")), { once: true });
        video.currentTime = Math.max(0, t);
      });

      const { width, height } = drawScaledFrame(video, canvas);
      const src = frameToTensor(ctx, width, height);
      const outputs = await session.run({
        src,
        r1i: rec[0],
        r2i: rec[1],
        r3i: rec[2],
        r4i: rec[3],
        downsample_ratio: downsampleRatio,
      });
      rec = [outputs.r1o, outputs.r2o, outputs.r3o, outputs.r4o];
      dataUrls.push(alphaToDataUrl(outputs.pha, width, height));

      setCutoutStatus(`Cutting out background — frame ${i + 1}/${frameCount}`);
    }

    return { dataUrls, fps: sampleFps };
  } finally {
    URL.revokeObjectURL(url);
    setCutoutStatus(null);
  }
}
