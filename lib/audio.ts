"use client";

import type { MediaItem } from "./types";

// In-browser speech-to-text — no server, no API key, no cost. Runs Whisper
// (via Transformers.js / ONNX Runtime Web, WASM) entirely on-device, the
// same local-first promise as everything else: the audio never leaves the
// browser, only the resulting text does (into the chat, not to any API).

let pipelinePromise: Promise<unknown> | null = null;

// The whisper-small fp32 download (~970MB, see below for why it has to be
// fp32) can take a couple of minutes on a slow connection. With no visible
// feedback that just reads as "stuck" — this is a tiny pub-sub so any UI
// (the chat panel's loading indicator) can show real download progress
// instead of a generic spinner.
type AsrStatusListener = (message: string | null) => void;
const asrStatusListeners = new Set<AsrStatusListener>();

export function subscribeAsrStatus(listener: AsrStatusListener): () => void {
  asrStatusListeners.add(listener);
  return () => asrStatusListeners.delete(listener);
}

function setAsrStatus(message: string | null) {
  for (const listener of asrStatusListeners) listener(message);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getAsrPipeline(): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const progress_callback = (data: any) => {
        if (data.status === "progress" && typeof data.progress === "number") {
          setAsrStatus(`Downloading speech model — ${Math.round(data.progress)}% (first time only, then it's cached)`);
        } else if (data.status === "ready" || data.status === "done") {
          setAsrStatus(null);
        }
      };
      // fp32, not a quantized dtype: confirmed in production that whisper's
      // decoder embedding layer ships 4-bit block-quantized (MatMulNBits)
      // under the "q8" preset for whisper-small too (not just whisper-base),
      // and ONNX Runtime Web's WASM backend can't create a session for it
      // ("TransposeDQWeightsForMatMulNBits Missing required scale") —
      // reliably, not intermittently. A try/q8-then-catch/fp32 fallback
      // isn't safe here either: a failed WASM session creation can leave the
      // runtime in a state where the very next session creation attempt
      // fails too, even for an architecturally unrelated (non-quantized)
      // model, so don't gamble on q8 in the same page load at all — fp32
      // costs a larger download (~970MB) but is the one dtype confirmed to
      // actually work.
      return await pipeline("automatic-speech-recognition", "Xenova/whisper-small", { dtype: "fp32", progress_callback });
    })()
      .catch((err) => {
        // Don't let a failed load poison every future attempt — clear the
        // cache so the next transcribe call gets a fresh try instead of
        // permanently re-throwing this same rejected promise.
        pipelinePromise = null;
        throw err;
      })
      .finally(() => setAsrStatus(null));
  }
  return pipelinePromise;
}

// Transformers.js's ASR pipeline never runs Whisper's own language
// auto-detection — when no `language` is passed it silently forces English
// decoding (`_retrieve_init_tokens` warns "No language specified -
// defaulting to English" and hardcodes "en"). Confirmed against real
// Manglish/Malay footage: forced-English decoding didn't just get some
// words wrong, it hallucinated a fully different, fluent-sounding English
// sentence with no relation to the actual (Malay) audio. Reimplement the
// one-token forward pass OpenAI's own `model.detect_language()` uses: feed
// only the <|startoftranscript|> token into the decoder and read back its
// top-predicted language token, then use that for the real transcription.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function detectLanguage(transcriber: any, samples: Float32Array): Promise<string | undefined> {
  try {
    const gc = transcriber.model.generation_config;
    if (!gc?.is_multilingual) return undefined;
    const { Tensor } = await import("@huggingface/transformers");
    const window = samples.subarray(0, Math.min(samples.length, 16000 * 30));
    const features = await transcriber.processor(window);
    const decoderInputIds = new Tensor("int64", new BigInt64Array([BigInt(gc.decoder_start_token_id)]), [1, 1]);
    const out = await transcriber.model.generate({
      inputs: features.input_features,
      decoder_input_ids: decoderInputIds,
      max_new_tokens: 1,
      num_beams: 1,
      do_sample: false,
    });
    const seq: bigint[][] = out.tolist ? out.tolist() : out;
    const predictedId = Number(seq[0][seq[0].length - 1]);
    const langEntry = Object.entries(gc.lang_to_id as Record<string, number>).find(([, id]) => id === predictedId);
    return langEntry ? langEntry[0].replace(/[<|>]/g, "") : undefined;
  } catch {
    return undefined; // fall back to the pipeline's own default rather than failing the transcription
  }
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
  const language = await detectLanguage(transcriber, slice);
  const result = await transcriber(slice, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    ...(language ? { language } : {}),
  });

  const rawChunks: Array<{ text: string; timestamp: [number, number | null] }> = result.chunks ?? [];
  const chunks: TranscriptChunk[] = rawChunks.map((c) => ({
    text: c.text.trim(),
    start: startSec + c.timestamp[0],
    end: startSec + (c.timestamp[1] ?? c.timestamp[0]),
  }));

  return { text: (result.text ?? "").trim(), chunks, hasAudioTrack: true };
}
