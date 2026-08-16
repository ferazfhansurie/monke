"use client";

import type { MediaItem } from "./types";

// In-browser speech-to-text — no server, no API key, no cost. Runs Whisper
// (via Transformers.js / ONNX Runtime Web, WASM) entirely on-device, the
// same local-first promise as everything else: the audio never leaves the
// browser, only the resulting text does (into the chat, not to any API).

let pipelinePromise: Promise<unknown> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getAsrPipeline(): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return pipeline("automatic-speech-recognition", "Xenova/whisper-base", { dtype: "q8" });
    })();
  }
  return pipelinePromise;
}

// Whisper expects raw PCM Float32 samples at 16kHz mono. Web Audio only
// decodes a whole file at once (no partial-range decode), so we decode
// once per item and cache the resampled track — repeated transcribe calls
// on the same clip (e.g. different windows) don't re-decode from scratch.
const decodedCache = new Map<string, Float32Array>();

async function decodeMono16k(item: MediaItem): Promise<Float32Array> {
  const cached = decodedCache.get(item.id);
  if (cached) return cached;

  const file = await item.handle.getFile();
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    decodeCtx.close();
  }

  const targetRate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded; // stereo->mono downmix happens automatically connecting into a 1-channel destination
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);

  decodedCache.set(item.id, samples);
  return samples;
}

export interface TranscriptChunk {
  text: string;
  start: number;
  end: number;
}

export interface TranscriptResult {
  text: string;
  chunks: TranscriptChunk[];
  hasAudioTrack: boolean;
}

// Transcribes [startSec, endSec) of an item's audio track. No audio track
// (e.g. a silent clip, or decode failure) resolves to an empty, non-error
// result — callers report that plainly rather than treating it as a crash.
export async function transcribeAudio(item: MediaItem, startSec: number, endSec: number): Promise<TranscriptResult> {
  let samples: Float32Array;
  try {
    samples = await decodeMono16k(item);
  } catch {
    return { text: "", chunks: [], hasAudioTrack: false };
  }
  if (samples.length === 0) return { text: "", chunks: [], hasAudioTrack: false };

  const rate = 16000;
  const startIdx = Math.max(0, Math.floor(startSec * rate));
  const endIdx = Math.min(samples.length, Math.ceil(endSec * rate));
  if (endIdx <= startIdx) return { text: "", chunks: [], hasAudioTrack: true };
  const slice = samples.subarray(startIdx, endIdx);

  const transcriber = await getAsrPipeline();
  const result = await transcriber(slice, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });

  const rawChunks: Array<{ text: string; timestamp: [number, number | null] }> = result.chunks ?? [];
  const chunks: TranscriptChunk[] = rawChunks.map((c) => ({
    text: c.text.trim(),
    start: startSec + c.timestamp[0],
    end: startSec + (c.timestamp[1] ?? c.timestamp[0]),
  }));

  return { text: (result.text ?? "").trim(), chunks, hasAudioTrack: true };
}
