"use client";

import { MessageSquare, Plus, Clock } from "lucide-react";
import { useMonkeStore } from "@/lib/store";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Shown right after opening a folder that already has MONKe conversations
// in it — the "pick up where you left off" step. Without this, reopening a
// folder silently restored *some* conversation with no indication that
// others existed, which read as "my history is gone".
export function WorkspacePrompt() {
  const prompt = useMonkeStore((s) => s.workspacePrompt);
  const choose = useMonkeStore((s) => s.chooseWorkspaceConversation);

  if (!prompt) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-white/10 bg-[#161b22] shadow-2xl">
        <div className="border-b border-white/10 px-4 py-3">
          <h2 className="text-[13px] font-semibold text-gray-100">Continue in “{prompt.projectName}”</h2>
          <p className="mt-0.5 text-[11px] text-gray-500">
            This folder has {prompt.picks.length} saved conversation{prompt.picks.length === 1 ? "" : "s"}. Pick one to pick up, or start fresh.
          </p>
        </div>

        <div className="max-h-72 overflow-y-auto py-1">
          {prompt.picks.map((pick) => (
            <button
              key={pick.id}
              type="button"
              onClick={() => choose(pick.id)}
              className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-white/5"
            >
              <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-600" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-gray-200">{pick.label}</span>
                <span className="mt-0.5 flex items-center gap-1 text-[10px] text-gray-500">
                  <Clock className="h-2.5 w-2.5" />
                  {relativeTime(pick.when)} · {pick.messageCount} message{pick.messageCount === 1 ? "" : "s"}
                  {pick.isLive && <span className="ml-1 rounded bg-[#f26522]/15 px-1 py-px font-semibold text-[#f26522]">last open</span>}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="border-t border-white/10 p-2">
          <button
            type="button"
            onClick={() => choose(null)}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-gray-300 hover:bg-white/5"
          >
            <Plus className="h-3.5 w-3.5 text-gray-500" />
            Start a new conversation
            <span className="ml-auto text-[10px] text-gray-600">others stay in History</span>
          </button>
        </div>
      </div>
    </div>
  );
}
