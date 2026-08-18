"use client";

import type { ChatMessage, ChatSession, ProjectSettings, Timeline } from "./types";

// A folder's own MONKe workspace file, written INSIDE the folder the user
// opened (".monke/workspace.json"), the way an editor keeps ".vscode/".
//
// Why in the folder rather than only IndexedDB: IndexedDB is keyed to one
// browser profile on one machine, so conversations were invisible the
// moment you opened the same footage anywhere else — and there was nothing
// in the folder to "choose from" when reopening it. Keeping the record
// beside the footage means the work travels with it.
//
// Media itself is never copied here — only the edit decisions, chat, and
// settings, all of which reference media by the deterministic id derived
// from its filename (see mediaIdForName in fs.ts).

const WORKSPACE_DIR = ".monke";
const WORKSPACE_FILE = "workspace.json";
const WORKSPACE_VERSION = 1;

export interface WorkspaceFile {
  version: number;
  updatedAt: string;
  projectName: string;
  // The conversation currently open in the chat panel, if any.
  liveConversation: ChatMessage[];
  // Previously-archived conversations, newest first.
  conversations: ChatSession[];
  timeline: Timeline | null;
  settings: ProjectSettings | null;
  chatModel: string | null;
}

// Frame captures are large and re-derivable — same reason the IndexedDB
// persistence strips them. Keeps the workspace file human-readable and
// small enough to live in a footage folder without being obnoxious.
function stripImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({ ...m, parts: m.parts.map((p) => ({ ...p, imageDataUrls: undefined })) }));
}

export async function readWorkspace(dir: FileSystemDirectoryHandle): Promise<WorkspaceFile | null> {
  try {
    const wsDir = await dir.getDirectoryHandle(WORKSPACE_DIR);
    const fileHandle = await wsDir.getFileHandle(WORKSPACE_FILE);
    const text = await (await fileHandle.getFile()).text();
    const parsed = JSON.parse(text) as WorkspaceFile;
    if (!parsed || typeof parsed !== "object") return null;
    // Forward-compatibility: a file written by a NEWER MONKe than this one
    // may have a shape we'd misread. Ignore it rather than corrupting it.
    if (typeof parsed.version !== "number" || parsed.version > WORKSPACE_VERSION) return null;
    return {
      ...parsed,
      liveConversation: parsed.liveConversation ?? [],
      conversations: parsed.conversations ?? [],
    };
  } catch {
    // No .monke dir/file yet (the common case for a fresh folder), or the
    // file is unreadable/corrupt — either way there's nothing to resume.
    return null;
  }
}

export async function writeWorkspace(
  dir: FileSystemDirectoryHandle,
  data: Omit<WorkspaceFile, "version" | "updatedAt">
): Promise<boolean> {
  try {
    const wsDir = await dir.getDirectoryHandle(WORKSPACE_DIR, { create: true });
    const fileHandle = await wsDir.getFileHandle(WORKSPACE_FILE, { create: true });
    const payload: WorkspaceFile = {
      ...data,
      liveConversation: stripImages(data.liveConversation),
      conversations: data.conversations.map((c) => ({ ...c, messages: stripImages(c.messages) })),
      version: WORKSPACE_VERSION,
      updatedAt: new Date().toISOString(),
    };
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();
    return true;
  } catch (err) {
    // Permission lapsed, read-only volume, disk full — never let saving the
    // sidecar take down the app; IndexedDB persistence still has the data.
    console.error("Couldn't write .monke/workspace.json:", err);
    return false;
  }
}

// A short human-readable label for a conversation in the picker.
export function conversationPreview(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = firstUser?.parts.find((p) => p.type === "text")?.text?.trim();
  if (!text) return "(empty conversation)";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
