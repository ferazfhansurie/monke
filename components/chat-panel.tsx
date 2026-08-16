"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Film, Captions, Mic, Music, FolderTree, Send, Plus, History, Loader2, ChevronDown, Check, Square, X } from "lucide-react";
import { useMonkeStore } from "@/lib/store";
import { CHAT_MODELS } from "@/lib/models";
import { captureFrames } from "@/lib/fs";
import { transcribeAudio } from "@/lib/audio";
import { startVideoGeneration } from "@/lib/generation";
import { Markdown } from "./markdown";
import type { ChatMessage, ChatMessagePart, ClipMask, ClipRect } from "@/lib/types";

const STARTERS = [
  { icon: Sparkles, label: "Analyse my clips" },
  { icon: Film, label: "Cut these clips together in order" },
  { icon: Captions, label: "Trim the start of the first clip" },
  { icon: Mic, label: "Create a voiceover" },
  { icon: Music, label: "Generate music and sync to my timeline" },
  { icon: FolderTree, label: "Organize my media into structured folders" },
];

const MAX_TURNS = 12;

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function sessionPreview(session: { messages: ChatMessage[] }): string {
  const firstUserText = session.messages.find((m) => m.role === "user")?.parts.find((p) => p.type === "text")?.text;
  return firstUserText?.trim() || "(empty conversation)";
}

// Anthropic tool_use.input arrives as unknown JSON — narrow it per-tool
// before use so a malformed call fails loudly instead of silently no-op-ing.
function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" ? v : undefined;
}
function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" ? v : undefined;
}
function parsePosition(input: Record<string, unknown>, key: string): ClipRect | undefined {
  const v = input[key];
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const x = num(o, "x"),
    y = num(o, "y"),
    width = num(o, "width"),
    height = num(o, "height");
  if (x == null || y == null || width == null || height == null) return undefined;
  return { x, y, width, height };
}
function parseMask(input: Record<string, unknown>, key: string): ClipMask | undefined {
  const v = input[key];
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const shape = str(o, "shape");
  if (shape !== "rect" && shape !== "ellipse") return undefined;
  return {
    shape,
    insetTop: num(o, "inset_top") ?? 0,
    insetRight: num(o, "inset_right") ?? 0,
    insetBottom: num(o, "inset_bottom") ?? 0,
    insetLeft: num(o, "inset_left") ?? 0,
  };
}

// Converts the store's display-oriented ChatMessage[] into the Anthropic
// Messages API shape. Kept as a pure function (not stored) so the two
// representations can't drift — the store is the single source of truth.
//
// keepImagesAfterIndex bounds how many trailing messages still carry their
// captured frames — every image ever probed was otherwise being resent on
// EVERY subsequent turn (turn N resends turns 1..N-1's images too), so an
// analysis that probes footage 8-10 times before building was re-uploading
// dozens of frames per request, growing every turn. That's almost
// certainly why long probing sessions were hanging/timing out. Older
// bursts fall back to their text summary only — the model already reasoned
// over the pixels when it saw them; it doesn't need them replayed forever.
function toAnthropicMessages(messages: ChatMessage[], keepImagesAfterIndex = 0): Array<{ role: "user" | "assistant"; content: unknown }> {
  return messages.map((m, idx) => ({
    role: m.role,
    content: m.parts.map((p) => {
      if (p.type === "text") return { type: "text", text: p.text ?? "" };
      if (p.type === "tool_use") return { type: "tool_use", id: p.toolUseId, name: p.name, input: p.input ?? {} };
      if (p.type === "tool_result" && idx >= keepImagesAfterIndex && p.imageDataUrls && p.imageDataUrls.length > 0) {
        return {
          type: "tool_result",
          tool_use_id: p.toolUseId,
          is_error: p.isError || undefined,
          content: [
            { type: "text", text: p.content ?? "" },
            ...p.imageDataUrls.map((dataUrl) => {
              const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
              return { type: "image", source: { type: "base64", media_type: match?.[1] ?? "image/jpeg", data: match?.[2] ?? "" } };
            }),
          ],
        };
      }
      return { type: "tool_result", tool_use_id: p.toolUseId, content: p.content ?? "", is_error: p.isError || undefined };
    }),
  }));
}

function buildTimelineContext(): string {
  const { items, timeline } = useMonkeStore.getState();
  const libraryLines =
    items.length === 0
      ? "Empty — nothing imported yet."
      : items.map((i) => `- ${i.id}: "${i.name}" (${i.kind}${i.durationSec ? `, ${i.durationSec.toFixed(1)}s` : ""})`).join("\n");

  const baseClips = timeline.clips.filter((c) => (c.trackIndex ?? 0) === 0).sort((a, b) => a.order - b.order);
  const totalDuration = baseClips.reduce((sum, c) => sum + Math.max(0, c.trimOut - c.trimIn), 0);
  const baseLines =
    baseClips.length === 0
      ? "Empty."
      : baseClips
          .map((c) => {
            const item = items.find((i) => i.id === c.mediaId);
            return `- clip ${c.id} (order ${c.order}): media ${c.mediaId} "${item?.name ?? "?"}", trim ${c.trimIn.toFixed(1)}s-${c.trimOut.toFixed(1)}s`;
          })
          .join("\n");

  const overlayClips = timeline.clips.filter((c) => (c.trackIndex ?? 0) > 0).sort((a, b) => (a.trackIndex ?? 0) - (b.trackIndex ?? 0));
  const overlayLines =
    overlayClips.length === 0
      ? "None."
      : overlayClips
          .map((c) => {
            const item = items.find((i) => i.id === c.mediaId);
            return `- clip ${c.id} (track ${c.trackIndex}): media ${c.mediaId} "${item?.name ?? "?"}", trim ${c.trimIn.toFixed(1)}s-${c.trimOut.toFixed(1)}s, starts at ${(c.timelineStart ?? 0).toFixed(1)}s`;
          })
          .join("\n");

  const captionLines =
    timeline.captions.length === 0
      ? "None."
      : [...timeline.captions]
          .sort((a, b) => a.start - b.start)
          .map((c) => `- caption ${c.id}: "${c.text}" ${c.start.toFixed(1)}s-${c.end.toFixed(1)}s (${c.fontFamily}, ${c.fontSize}px)`)
          .join("\n");

  return `## CURRENT LIBRARY\n${libraryLines}\n\n## CURRENT TIMELINE (base track, total ${totalDuration.toFixed(1)}s)\n${baseLines}\n\n## CURRENT OVERLAYS\n${overlayLines}\n\n## CURRENT CAPTIONS\n${captionLines}`;
}

interface ToolResult {
  ok: boolean;
  message: string;
  imageDataUrls?: string[];
}

async function dispatchTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const store = useMonkeStore.getState();
  try {
    if (name === "timeline_build_sequence") {
      const clipsInput = input["clips"];
      if (!Array.isArray(clipsInput) || clipsInput.length === 0) {
        return { ok: false, message: "clips must be a non-empty array." };
      }
      const resolved: { mediaId: string; trimIn: number; trimOut: number }[] = [];
      for (const raw of clipsInput) {
        if (typeof raw !== "object" || raw === null) return { ok: false, message: "Each clip entry must be an object." };
        const c = raw as Record<string, unknown>;
        const mediaId = str(c, "media_id");
        const item = mediaId ? store.items.find((i) => i.id === mediaId) : undefined;
        if (!item) return { ok: false, message: `No library item with id "${mediaId}".` };
        const trimIn = num(c, "trim_in") ?? 0;
        const trimOut = num(c, "trim_out") ?? item.durationSec ?? trimIn + 5;
        if (trimIn >= trimOut) return { ok: false, message: `trim_in must be less than trim_out for "${item.name}".` };
        resolved.push({ mediaId: item.id, trimIn, trimOut });
      }
      store.buildSequence(resolved);
      return { ok: true, message: `Built a ${resolved.length}-clip sequence on the timeline.` };
    }
    if (name === "generate_stock_clip") {
      const prompt = str(input, "prompt");
      if (!prompt) return { ok: false, message: "prompt is required" };
      if (input["confirmed"] !== true) {
        return {
          ok: false,
          message:
            "Not started — this costs real money, so present the plan (prompt, duration, resolution, aspect ratio, intended use) as a message first and wait for the user's explicit go-ahead before calling this tool again with confirmed: true.",
        };
      }
      const durationSec = num(input, "duration_seconds");
      const resolution = str(input, "resolution") as "480p" | "720p" | "1080p" | undefined;
      const aspectRatio = str(input, "aspect_ratio");
      try {
        const { requestId } = await startVideoGeneration(prompt, { durationSec, resolution, aspectRatio });
        store.addPendingGeneration(requestId, prompt);
        return {
          ok: true,
          message: `Started generating "${prompt}" (takes about 2 minutes). It'll be auto-imported into the library and announced in chat when ready — no need to check back.`,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed to start generation" };
      }
    }
    if (name === "timeline_transcribe_clip") {
      const clipId = str(input, "clip_id");
      const mediaIdInput = str(input, "media_id");
      let item: (typeof store.items)[number] | undefined;
      let rangeStart = 0;
      let rangeEnd = 0;
      let label = "";
      if (clipId) {
        const clip = store.timeline.clips.find((c) => c.id === clipId);
        if (!clip) return { ok: false, message: `No timeline clip with id "${clipId}".` };
        item = store.items.find((i) => i.id === clip.mediaId);
        if (!item) return { ok: false, message: "That clip's source media isn't in the library." };
        rangeStart = clip.trimIn;
        rangeEnd = clip.trimOut;
        label = `clip ${clipId} ("${item.name}")`;
      } else if (mediaIdInput) {
        item = store.items.find((i) => i.id === mediaIdInput);
        if (!item) return { ok: false, message: `No library item with id "${mediaIdInput}".` };
        rangeStart = 0;
        rangeEnd = item.durationSec ?? 0;
        label = `media ${mediaIdInput} ("${item.name}")`;
      } else {
        return { ok: false, message: "Provide either clip_id or media_id." };
      }
      if (item.kind !== "video" && item.kind !== "audio") {
        return { ok: false, message: `"${item.name}" is ${item.kind} — no audio to transcribe.` };
      }
      const startSeconds = rangeStart + Math.max(0, num(input, "start_seconds") ?? 0);
      const endSeconds = num(input, "end_seconds") != null ? rangeStart + num(input, "end_seconds")! : rangeEnd;
      if (endSeconds <= startSeconds) return { ok: false, message: "end_seconds must be after start_seconds." };

      const result = await transcribeAudio(item, startSeconds, endSeconds);
      if (!result.hasAudioTrack) {
        return { ok: true, message: `${label} has no usable audio track (silent, or the format isn't decodable in-browser).` };
      }
      if (!result.text) {
        return { ok: true, message: `${label}, ${startSeconds.toFixed(1)}s-${endSeconds.toFixed(1)}s: no speech detected (silence, music-only, or noise).` };
      }
      const segmentLines = result.chunks.map((c) => `[${c.start.toFixed(1)}s-${c.end.toFixed(1)}s] ${c.text}`).join("\n");
      return {
        ok: true,
        message: `Transcript of ${label}, ${startSeconds.toFixed(1)}s-${endSeconds.toFixed(1)}s:\n"${result.text}"\n\nSegments:\n${segmentLines}`,
      };
    }
    if (name === "add_captions") {
      const rawCaptions = input["captions"];
      if (!Array.isArray(rawCaptions) || rawCaptions.length === 0) return { ok: false, message: "captions must be a non-empty array." };
      const fontFamily = str(input, "font_family") ?? "Inter";
      const fontSize = num(input, "font_size") ?? 64;
      const color = str(input, "color") ?? "#ffffff";
      const position = parsePosition(input, "position") ?? { x: 0.05, y: 0.78, width: 0.9, height: 0.15 };
      const bold = typeof input["bold"] === "boolean" ? (input["bold"] as boolean) : true;
      const ids: string[] = [];
      for (const raw of rawCaptions) {
        if (typeof raw !== "object" || raw === null) return { ok: false, message: "Each caption entry must be an object." };
        const c = raw as Record<string, unknown>;
        const text = str(c, "text");
        const start = num(c, "start");
        const end = num(c, "end");
        if (!text || start == null || end == null) return { ok: false, message: "Each caption needs text, start, and end." };
        if (end <= start) return { ok: false, message: `Caption "${text}" has end <= start.` };
        ids.push(store.addCaption({ text, start, end, fontFamily, fontSize, color, position, bold }));
      }
      return { ok: true, message: `Added ${ids.length} caption${ids.length === 1 ? "" : "s"} (${fontFamily}, ${fontSize}px).` };
    }
    if (name === "update_caption") {
      const captionId = str(input, "caption_id");
      const caption = captionId ? store.timeline.captions.find((c) => c.id === captionId) : undefined;
      if (!caption) return { ok: false, message: `No caption with id "${captionId}".` };
      const position = parsePosition(input, "position");
      store.updateCaption(caption.id, {
        ...(str(input, "text") ? { text: str(input, "text") } : {}),
        ...(num(input, "start") != null ? { start: num(input, "start") } : {}),
        ...(num(input, "end") != null ? { end: num(input, "end") } : {}),
        ...(str(input, "font_family") ? { fontFamily: str(input, "font_family") } : {}),
        ...(num(input, "font_size") != null ? { fontSize: num(input, "font_size") } : {}),
        ...(str(input, "color") ? { color: str(input, "color") } : {}),
        ...(position ? { position } : {}),
        ...(typeof input["bold"] === "boolean" ? { bold: input["bold"] as boolean } : {}),
      });
      return { ok: true, message: `Updated caption ${caption.id}.` };
    }
    if (name === "remove_caption") {
      const captionId = str(input, "caption_id");
      if (!captionId || !store.timeline.captions.some((c) => c.id === captionId)) {
        return { ok: true, message: `Caption "${captionId}" is already not on the timeline.` };
      }
      store.removeCaption(captionId);
      return { ok: true, message: `Removed caption ${captionId}.` };
    }
    if (name === "timeline_probe_clip") {
      const clipId = str(input, "clip_id");
      const mediaIdInput = str(input, "media_id");
      const frameCount = Math.min(12, Math.max(1, Math.round(num(input, "frame_count") ?? 6)));
      const stepSeconds = Math.min(2, Math.max(0.05, num(input, "step_seconds") ?? 0.05));
      const windowSec = (frameCount - 1) * stepSeconds;

      let item: (typeof store.items)[number] | undefined;
      let rangeStart = 0;
      let rangeEnd = 0;
      let startAt = 0;
      let label = "";
      if (clipId) {
        const clip = store.timeline.clips.find((c) => c.id === clipId);
        if (!clip) return { ok: false, message: `No timeline clip with id "${clipId}".` };
        item = store.items.find((i) => i.id === clip.mediaId);
        if (!item) return { ok: false, message: "That clip's source media isn't in the library." };
        rangeStart = clip.trimIn;
        rangeEnd = clip.trimOut;
        const dur = Math.max(0, rangeEnd - rangeStart);
        const requested = num(input, "at_seconds") ?? Math.max(0, dur / 2 - windowSec / 2);
        startAt = rangeStart + Math.min(Math.max(0, requested), Math.max(0, dur - windowSec));
        label = `clip ${clipId}`;
      } else if (mediaIdInput) {
        item = store.items.find((i) => i.id === mediaIdInput);
        if (!item) return { ok: false, message: `No library item with id "${mediaIdInput}".` };
        rangeStart = 0;
        rangeEnd = item.durationSec ?? windowSec;
        const dur = Math.max(0, rangeEnd - rangeStart);
        const requested = num(input, "at_seconds") ?? Math.max(0, dur / 2 - windowSec / 2);
        startAt = Math.min(Math.max(0, requested), Math.max(0, dur - windowSec));
        label = `media ${mediaIdInput}`;
      } else {
        return { ok: false, message: "Provide either clip_id or media_id." };
      }
      if (item.kind !== "video" && item.kind !== "image") {
        return { ok: false, message: `"${item.name}" is ${item.kind}, not video or image — nothing to see.` };
      }
      if (item.kind === "image") {
        const imageDataUrls = await captureFrames(item, [0]);
        return { ok: true, message: `Captured "${item.name}" (a single still image, no motion to sample).`, imageDataUrls };
      }
      const times = Array.from({ length: frameCount }, (_, i) => startAt + i * stepSeconds);
      const imageDataUrls = await captureFrames(item, times);
      return {
        ok: true,
        message: `Captured ${frameCount} frames from ${label} ("${item.name}"), ${startAt.toFixed(2)}s-${(startAt + windowSec).toFixed(2)}s at ${stepSeconds}s spacing.`,
        imageDataUrls,
      };
    }
    if (name === "timeline_add_clip") {
      const mediaId = str(input, "media_id");
      if (!mediaId) return { ok: false, message: "media_id is required" };
      const item = store.items.find((i) => i.id === mediaId);
      if (!item) return { ok: false, message: `No library item with id "${mediaId}".` };
      const trimIn = num(input, "trim_in");
      const trimOut = num(input, "trim_out");
      const order = num(input, "order");
      const trackIndex = num(input, "track_index");
      const timelineStart = num(input, "timeline_start");
      if ((trackIndex ?? 0) > 0 && timelineStart == null) {
        return { ok: false, message: "timeline_start is required when track_index >= 1 (overlay clips need an explicit position on the master timeline)." };
      }
      const position = parsePosition(input, "position");
      const opacity = num(input, "opacity");
      const mask = parseMask(input, "mask");
      const volume = num(input, "volume");
      const muted = typeof input["muted"] === "boolean" ? (input["muted"] as boolean) : undefined;
      const clipId = store.addTimelineClip(mediaId, { trimIn, trimOut, order, trackIndex, timelineStart, position, opacity, mask, volume, muted });
      const layerNote = (trackIndex ?? 0) > 0 ? ` as an overlay on track ${trackIndex}, starting at ${timelineStart}s` : "";
      return { ok: true, message: `Added clip ${clipId} ("${item.name}") to the timeline${layerNote}.` };
    }
    if (name === "timeline_trim_clip") {
      const clipId = str(input, "clip_id");
      const clip = clipId ? store.timeline.clips.find((c) => c.id === clipId) : undefined;
      if (!clip) return { ok: false, message: `No timeline clip with id "${clipId}".` };
      const trimIn = num(input, "trim_in") ?? clip.trimIn;
      const trimOut = num(input, "trim_out") ?? clip.trimOut;
      if (trimIn >= trimOut) return { ok: false, message: "trim_in must be less than trim_out." };
      const trackIndex = num(input, "track_index");
      const timelineStart = num(input, "timeline_start");
      if ((trackIndex ?? clip.trackIndex ?? 0) > 0 && timelineStart == null && clip.timelineStart == null) {
        return { ok: false, message: "timeline_start is required when moving a clip to track_index >= 1." };
      }
      const position = parsePosition(input, "position");
      const opacity = num(input, "opacity");
      const mask = parseMask(input, "mask");
      const volume = num(input, "volume");
      const muted = typeof input["muted"] === "boolean" ? (input["muted"] as boolean) : undefined;
      store.updateTimelineClip(clip.id, {
        trimIn,
        trimOut,
        ...(trackIndex != null ? { trackIndex } : {}),
        ...(timelineStart != null ? { timelineStart } : {}),
        ...(position ? { position } : {}),
        ...(opacity != null ? { opacity } : {}),
        ...(mask ? { mask } : {}),
        ...(volume != null ? { volume } : {}),
        ...(muted != null ? { muted } : {}),
      });
      return { ok: true, message: `Clip ${clip.id} trimmed to ${trimIn.toFixed(1)}s-${trimOut.toFixed(1)}s.` };
    }
    if (name === "timeline_reorder_clip") {
      const clipId = str(input, "clip_id");
      const order = num(input, "order");
      const clip = clipId ? store.timeline.clips.find((c) => c.id === clipId) : undefined;
      if (!clip || order == null) return { ok: false, message: `No timeline clip with id "${clipId}".` };
      store.reorderTimelineClip(clip.id, order);
      return { ok: true, message: `Clip ${clip.id} moved to position ${order}.` };
    }
    if (name === "timeline_split_clip") {
      const clipId = str(input, "clip_id");
      const atSeconds = num(input, "at_seconds");
      const clip = clipId ? store.timeline.clips.find((c) => c.id === clipId) : undefined;
      if (!clip || atSeconds == null) return { ok: false, message: `No timeline clip with id "${clipId}".` };
      const newId = store.splitTimelineClip(clip.id, atSeconds);
      if (!newId) return { ok: false, message: "Split point must be strictly inside the clip's own range." };
      return { ok: true, message: `Split clip ${clip.id} into ${clip.id} and ${newId}.` };
    }
    if (name === "timeline_remove_clip") {
      const clipId = str(input, "clip_id");
      if (!clipId || !store.timeline.clips.some((c) => c.id === clipId)) {
        return { ok: true, message: `Clip "${clipId}" is already not on the timeline.` };
      }
      store.removeTimelineClip(clipId);
      return { ok: true, message: `Removed clip ${clipId}.` };
    }
    return { ok: false, message: `Unknown tool: ${name}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Tool execution failed" };
  }
}

export function ChatPanel() {
  const messages = useMonkeStore((s) => s.messages);
  const pushMessage = useMonkeStore((s) => s.pushMessage);
  const clearChat = useMonkeStore((s) => s.clearChat);
  const chatHistory = useMonkeStore((s) => s.chatHistory);
  const restoreChatSession = useMonkeStore((s) => s.restoreChatSession);
  const items = useMonkeStore((s) => s.items);
  const chatModel = useMonkeStore((s) => s.chatModel);
  const setChatModel = useMonkeStore((s) => s.setChatModel);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const currentModel = CHAT_MODELS.find((m) => m.id === chatModel) ?? CHAT_MODELS[0];

  // Queued messages sent while the agent is mid-run — held here and drained
  // one at a time once the current run finishes, instead of forcing the
  // user to wait for a long multi-tool-call analysis to finish before they
  // can type the next thing. A ref (not just state) so the finally-block
  // continuation always sees the latest queue, not a stale closure.
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const queueRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const stoppedByUserRef = useRef(false);
  const messageListRef = useRef<HTMLDivElement>(null);

  // A silently-stopped conversation (no error, no visible reply) reads as
  // "did it stop?" just as much as an actual bug does, if the newest
  // message isn't in view. Always scroll to the latest message/state.
  useEffect(() => {
    messageListRef.current?.scrollTo({ top: messageListRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const dequeueAndSendNext = () => {
    const next = queueRef.current.shift();
    setQueuedMessages([...queueRef.current]);
    if (next !== undefined) void send(next);
  };

  const removeQueuedMessage = (index: number) => {
    queueRef.current = queueRef.current.filter((_, i) => i !== index);
    setQueuedMessages([...queueRef.current]);
  };

  const stop = () => {
    stoppedByUserRef.current = true;
    abortRef.current?.abort();
  };

  // Public entry point from the input box / starter buttons: if the agent
  // is already mid-run, queue instead of blocking the user from typing the
  // next thing (or dropping it). Only the actual `send` below talks to the API.
  const submit = (text: string) => {
    if (!text.trim()) return;
    setInput("");
    if (loading) {
      queueRef.current = [...queueRef.current, text];
      setQueuedMessages([...queueRef.current]);
      return;
    }
    void send(text);
  };

  const send = async (text: string) => {
    if (!text.trim()) return;
    let history = [...messages, { id: "", role: "user" as const, parts: [{ type: "text" as const, text }], createdAt: "" }];
    pushMessage("user", [{ type: "text", text }]);
    setLoading(true);
    stoppedByUserRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;

    let finishedNaturally = false;
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            messages: toAnthropicMessages(history, Math.max(0, history.length - 4)),
            timelineContext: buildTimelineContext(),
            model: chatModel,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          pushMessage("assistant", [{ type: "text", text: `Error: ${data.error || "Request failed"}` }]);
          break;
        }

        const content = data.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
        // Claude's content blocks can be more than just "text"/"tool_use"
        // (e.g. "thinking") — anything else was previously falling through
        // to the tool_use branch with no id, producing a malformed tool_use
        // block that Anthropic's API then rejected on the next turn.
        let assistantParts: ChatMessagePart[] = content.flatMap((block): ChatMessagePart[] => {
          if (block.type === "text") return [{ type: "text", text: block.text }];
          if (block.type === "tool_use" && block.id) return [{ type: "tool_use", name: block.name, input: block.input, toolUseId: block.id }];
          return [];
        });
        // A response with no visible text/tool_use parts (e.g. an empty or
        // whitespace-only text block) renders as literally nothing —
        // the conversation just silently stops with no error and no
        // indication anything happened. Never let a turn vanish silently.
        const hasVisibleContent = assistantParts.some((p) => (p.type === "text" && p.text?.trim()) || p.type === "tool_use");
        if (!hasVisibleContent) {
          assistantParts = [{ type: "text", text: "_(No response for that message — try rephrasing or asking again.)_" }];
        }
        const assistantMsg = pushMessage("assistant", assistantParts);
        history = [...history, assistantMsg];

        if (data.stop_reason !== "tool_use") {
          finishedNaturally = true;
          break;
        }

        const toolUses = content.filter((b) => b.type === "tool_use");
        if (toolUses.length === 0) {
          finishedNaturally = true;
          break;
        }

        const resultParts: ChatMessagePart[] = await Promise.all(
          toolUses.map(async (tu) => {
            const result = await dispatchTool(tu.name!, tu.input || {});
            return { type: "tool_result" as const, toolUseId: tu.id, content: result.message, isError: !result.ok, imageDataUrls: result.imageDataUrls };
          })
        );
        const resultMsg = pushMessage("user", resultParts);
        history = [...history, resultMsg];
      }
      if (!finishedNaturally) {
        pushMessage("assistant", [
          {
            type: "text",
            text: `Ran out of steps for this request after ${MAX_TURNS} tool calls without finishing — footage this long may need a couple of messages. Say **"continue"** and I'll pick up where I left off.`,
          },
        ]);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        pushMessage("assistant", [{ type: "text", text: stoppedByUserRef.current ? "_Stopped._" : "_Cancelled._" }]);
      } else {
        pushMessage("assistant", [{ type: "text", text: `Error: ${err instanceof Error ? err.message : "Something went wrong"}` }]);
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
      dequeueAndSendNext();
    }
  };

  return (
    <div className="flex h-full flex-col border-r border-white/10 bg-[#0d1117]">
      <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-2">
        <span className="text-[11px] font-semibold text-gray-300">{messages.length === 0 ? "New chat" : "Chat"}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => clearChat()}
          disabled={messages.length === 0 || loading}
          className="rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-300 disabled:opacity-30 disabled:hover:bg-transparent"
          title="New chat — clears the current conversation"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            disabled={chatHistory.length === 0}
            className="rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-300 disabled:opacity-30 disabled:hover:bg-transparent"
            title={chatHistory.length === 0 ? "No past conversations yet" : "Chat history"}
          >
            <History className="h-3.5 w-3.5" />
          </button>
          {historyOpen && chatHistory.length > 0 && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setHistoryOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-64 max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-[#161b22] py-1 shadow-lg">
                {chatHistory.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => {
                      restoreChatSession(session.id);
                      setHistoryOpen(false);
                    }}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-white/5"
                  >
                    <span className="truncate text-[11px] text-gray-300">{sessionPreview(session)}</span>
                    <span className="text-[10px] text-gray-600">{relativeTime(session.endedAt)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div ref={messageListRef} className="flex-1 overflow-y-auto px-3 py-4">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-4">
            <p className="text-[11px] font-medium text-gray-500">Ask anything, or start with:</p>
            <div className="flex flex-col gap-1.5">
              {STARTERS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => submit(s.label)}
                  className="flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-left text-[12px] text-gray-300 hover:border-[#f26522]/50 hover:bg-[#f26522]/5 transition-colors"
                >
                  <s.icon className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                  {s.label}
                </button>
              ))}
            </div>
            {items.length === 0 && <p className="mt-2 text-[10px] text-gray-600">Open a folder first so I have footage to work with.</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) => {
              const textParts = m.parts.filter((p) => p.type === "text" && p.text);
              const toolParts = m.parts.filter((p) => p.type === "tool_use" || p.type === "tool_result");
              if (textParts.length === 0 && toolParts.length === 0) return null;
              return (
                <div key={m.id} className={`flex flex-col gap-1.5 ${m.role === "user" ? "items-end" : "items-start"}`}>
                  {textParts.map((p, i) => (
                    <div
                      key={i}
                      className={`max-w-[85%] rounded-xl px-3 py-2 text-[12px] leading-relaxed ${
                        m.role === "user" ? "bg-[#f26522] text-white" : "border border-white/10 bg-white/[0.03] text-gray-300"
                      }`}
                    >
                      {m.role === "assistant" ? <Markdown text={p.text ?? ""} /> : p.text}
                    </div>
                  ))}
                  {toolParts.map((p, i) => (
                    <div key={i} className="max-w-[85%] rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[10px] text-gray-500">
                      {p.type === "tool_use" ? (
                        <span>
                          <span className="font-mono text-[#f26522]/80">{p.name}</span>
                        </span>
                      ) : (
                        <div className="flex flex-col gap-1.5">
                          <span className={p.isError ? "text-red-400/80" : ""}>{p.content}</span>
                          {p.imageDataUrls && p.imageDataUrls.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {p.imageDataUrls.map((src, j) => (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img key={j} src={src} alt="Captured frame" className="h-14 w-auto rounded border border-white/10 object-contain" />
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
            {loading && (
              <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-white/10 p-2">
        {queuedMessages.length > 0 && (
          <div className="mb-1.5 flex flex-col gap-1">
            {queuedMessages.map((q, i) => (
              <div key={i} className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] text-gray-400">
                <span className="shrink-0 text-gray-600">Queued</span>
                <span className="flex-1 truncate">{q}</span>
                <button type="button" onClick={() => removeQueuedMessage(i)} className="shrink-0 rounded p-0.5 text-gray-600 hover:bg-white/10 hover:text-gray-300" title="Remove from queue">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1.5 focus-within:border-[#f26522]/50">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(input);
              }
            }}
            rows={1}
            placeholder={loading ? "Ask a follow-up — it'll queue until this finishes" : "Ask, or type @ to reference media"}
            className="max-h-24 w-full resize-none bg-transparent text-[12px] text-gray-200 placeholder:text-gray-600 outline-none"
          />
          {loading ? (
            <button
              type="button"
              onClick={stop}
              title="Stop"
              className="shrink-0 rounded-md bg-white/10 p-1.5 text-white hover:bg-white/20 transition-colors"
            >
              <Square className="h-3 w-3" fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => submit(input)}
              disabled={!input.trim()}
              className="shrink-0 rounded-md bg-[#f26522] p-1.5 text-white disabled:opacity-30 hover:bg-[#d9541a] transition-colors"
            >
              <Send className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="relative mt-1.5">
          <button
            type="button"
            onClick={() => setModelMenuOpen((v) => !v)}
            className="flex items-center gap-1 rounded px-0.5 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
          >
            {currentModel.label}
            <ChevronDown className="h-2.5 w-2.5" />
          </button>
          {modelMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setModelMenuOpen(false)} />
              <div className="absolute bottom-full left-0 z-50 mb-1 w-56 rounded-lg border border-white/10 bg-[#161b22] py-1 shadow-lg">
                {CHAT_MODELS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      setChatModel(m.id);
                      setModelMenuOpen(false);
                    }}
                    className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-white/5"
                  >
                    <Check className={`mt-0.5 h-3 w-3 shrink-0 ${m.id === chatModel ? "text-[#f26522]" : "text-transparent"}`} />
                    <span>
                      <span className="block text-[12px] text-gray-200">{m.label}</span>
                      <span className="block text-[10px] text-gray-500">{m.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
