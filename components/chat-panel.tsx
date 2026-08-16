"use client";

import { useState } from "react";
import { Sparkles, Film, Captions, Mic, Music, FolderTree, Send, Plus, History, Loader2, ChevronDown, Check } from "lucide-react";
import { useMonkeStore } from "@/lib/store";
import { CHAT_MODELS } from "@/lib/models";
import { captureFrames } from "@/lib/fs";
import type { ChatMessage, ChatMessagePart } from "@/lib/types";

const STARTERS = [
  { icon: Sparkles, label: "Analyse my clips" },
  { icon: Film, label: "Cut these clips together in order" },
  { icon: Captions, label: "Trim the start of the first clip" },
  { icon: Mic, label: "Create a voiceover" },
  { icon: Music, label: "Generate music and sync to my timeline" },
  { icon: FolderTree, label: "Organize my media into structured folders" },
];

const MAX_TURNS = 8;

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

// Converts the store's display-oriented ChatMessage[] into the Anthropic
// Messages API shape. Kept as a pure function (not stored) so the two
// representations can't drift — the store is the single source of truth.
function toAnthropicMessages(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: unknown }> {
  return messages.map((m) => ({
    role: m.role,
    content: m.parts.map((p) => {
      if (p.type === "text") return { type: "text", text: p.text ?? "" };
      if (p.type === "tool_use") return { type: "tool_use", id: p.toolUseId, name: p.name, input: p.input ?? {} };
      if (p.type === "tool_result" && p.imageDataUrls && p.imageDataUrls.length > 0) {
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
  const sortedClips = [...timeline.clips].sort((a, b) => a.order - b.order);
  const timelineLines =
    sortedClips.length === 0
      ? "Empty."
      : sortedClips
          .map((c) => {
            const item = items.find((i) => i.id === c.mediaId);
            return `- clip ${c.id} (order ${c.order}): media ${c.mediaId} "${item?.name ?? "?"}", trim ${c.trimIn.toFixed(1)}s-${c.trimOut.toFixed(1)}s`;
          })
          .join("\n");
  return `## CURRENT LIBRARY\n${libraryLines}\n\n## CURRENT TIMELINE\n${timelineLines}`;
}

interface ToolResult {
  ok: boolean;
  message: string;
  imageDataUrls?: string[];
}

async function dispatchTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const store = useMonkeStore.getState();
  try {
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
      const clipId = store.addTimelineClip(mediaId, { trimIn, trimOut, order });
      return { ok: true, message: `Added clip ${clipId} ("${item.name}") to the timeline.` };
    }
    if (name === "timeline_trim_clip") {
      const clipId = str(input, "clip_id");
      const clip = clipId ? store.timeline.clips.find((c) => c.id === clipId) : undefined;
      if (!clip) return { ok: false, message: `No timeline clip with id "${clipId}".` };
      const trimIn = num(input, "trim_in") ?? clip.trimIn;
      const trimOut = num(input, "trim_out") ?? clip.trimOut;
      if (trimIn >= trimOut) return { ok: false, message: "trim_in must be less than trim_out." };
      store.updateTimelineClip(clip.id, { trimIn, trimOut });
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
  const items = useMonkeStore((s) => s.items);
  const chatModel = useMonkeStore((s) => s.chatModel);
  const setChatModel = useMonkeStore((s) => s.setChatModel);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const currentModel = CHAT_MODELS.find((m) => m.id === chatModel) ?? CHAT_MODELS[0];

  const send = async (text: string) => {
    if (!text.trim() || loading) return;
    setInput("");
    let history = [...messages, { id: "", role: "user" as const, parts: [{ type: "text" as const, text }], createdAt: "" }];
    pushMessage("user", [{ type: "text", text }]);
    setLoading(true);

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: toAnthropicMessages(history), timelineContext: buildTimelineContext(), model: chatModel }),
        });
        const data = await res.json();
        if (!res.ok) {
          pushMessage("assistant", [{ type: "text", text: `Error: ${data.error || "Request failed"}` }]);
          break;
        }

        const content = data.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
        const assistantParts: ChatMessagePart[] = content.map((block) => {
          if (block.type === "text") return { type: "text", text: block.text };
          return { type: "tool_use", name: block.name, input: block.input, toolUseId: block.id };
        });
        const assistantMsg = pushMessage("assistant", assistantParts);
        history = [...history, assistantMsg];

        if (data.stop_reason !== "tool_use") break;

        const toolUses = content.filter((b) => b.type === "tool_use");
        if (toolUses.length === 0) break;

        const resultParts: ChatMessagePart[] = await Promise.all(
          toolUses.map(async (tu) => {
            const result = await dispatchTool(tu.name!, tu.input || {});
            return { type: "tool_result" as const, toolUseId: tu.id, content: result.message, isError: !result.ok, imageDataUrls: result.imageDataUrls };
          })
        );
        const resultMsg = pushMessage("user", resultParts);
        history = [...history, resultMsg];
      }
    } catch (err) {
      pushMessage("assistant", [{ type: "text", text: `Error: ${err instanceof Error ? err.message : "Something went wrong"}` }]);
    } finally {
      setLoading(false);
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
        <button type="button" disabled title="Chat history isn't built yet" className="rounded p-1 text-gray-700 cursor-not-allowed">
          <History className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-4">
            <p className="text-[11px] font-medium text-gray-500">Ask anything, or start with:</p>
            <div className="flex flex-col gap-1.5">
              {STARTERS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => send(s.label)}
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
                      {p.text}
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
        <div className="flex items-end gap-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1.5 focus-within:border-[#f26522]/50">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            placeholder="Ask, or type @ to reference media"
            disabled={loading}
            className="max-h-24 w-full resize-none bg-transparent text-[12px] text-gray-200 placeholder:text-gray-600 outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => send(input)}
            disabled={!input.trim() || loading}
            className="shrink-0 rounded-md bg-[#f26522] p-1.5 text-white disabled:opacity-30 hover:bg-[#d9541a] transition-colors"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          </button>
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
