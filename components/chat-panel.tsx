"use client";

import { useState } from "react";
import { Sparkles, Film, Captions, Mic, Music, FolderTree, Send, Plus, History } from "lucide-react";
import { useMonkeStore } from "@/lib/store";

const STARTERS = [
  { icon: Sparkles, label: "Generate an AI video" },
  { icon: Film, label: "Generate B-roll" },
  { icon: Captions, label: "Add captions to my timeline" },
  { icon: Mic, label: "Create a voiceover" },
  { icon: Music, label: "Generate music and sync to my timeline" },
  { icon: FolderTree, label: "Organize my media into structured folders" },
];

// The agent backend isn't wired yet (Phase 2 of the build) — this is the
// real chat UI/UX, honest about its current state rather than faking a
// response. Wiring it up is the next milestone: footage indexing (transcribe
// + frame probe) and the same timeline tool-calling pattern proven on
// MotionBoards, adapted to local File System Access media instead of
// uploaded canvas items.
export function ChatPanel() {
  const messages = useMonkeStore((s) => s.messages);
  const sendMessage = useMonkeStore((s) => s.sendMessage);
  const items = useMonkeStore((s) => s.items);
  const [input, setInput] = useState("");

  const send = (text: string) => {
    if (!text.trim()) return;
    sendMessage("user", text);
    setInput("");
    setTimeout(() => {
      sendMessage(
        "assistant",
        "The editing agent isn't connected yet — this is the interface only. Once wired up, I'll be able to see and cut your footage directly."
      );
    }, 400);
  };

  return (
    <div className="flex h-full flex-col border-r border-white/10 bg-[#0d1117]">
      <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-2">
        <span className="text-[11px] font-semibold text-gray-300">New chat</span>
        <div className="flex-1" />
        <button type="button" className="rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-300" title="New chat">
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-300" title="History">
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
            {items.length === 0 && (
              <p className="mt-2 text-[10px] text-gray-600">Open a folder first so I have footage to work with.</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-[12px] leading-relaxed ${
                    m.role === "user" ? "bg-[#f26522] text-white" : "border border-white/10 bg-white/[0.03] text-gray-300"
                  }`}
                >
                  {m.parts.map((p, i) => (p.type === "text" ? <span key={i}>{p.text}</span> : null))}
                </div>
              </div>
            ))}
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
            className="max-h-24 w-full resize-none bg-transparent text-[12px] text-gray-200 placeholder:text-gray-600 outline-none"
          />
          <button
            type="button"
            onClick={() => send(input)}
            disabled={!input.trim()}
            className="shrink-0 rounded-md bg-[#f26522] p-1.5 text-white disabled:opacity-30 hover:bg-[#d9541a] transition-colors"
          >
            <Send className="h-3 w-3" />
          </button>
        </div>
        <div className="mt-1.5 px-0.5 text-[10px] text-gray-600">Opus 4.8 · not connected</div>
      </div>
    </div>
  );
}
