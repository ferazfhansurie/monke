// Core data model for MONKe. A project is local-first: media files are never
// uploaded — we hold File System Access API handles and read bytes on demand.
// Only derived artifacts (transcripts, probed frames, generated voiceover)
// ever leave the browser, and only when the AI explicitly needs them.

export type MediaKind = "video" | "audio" | "image";

export interface MediaItem {
  id: string;
  name: string;
  kind: MediaKind;
  handle: FileSystemFileHandle;
  // Object URL for the underlying file, created lazily on first use and
  // revoked when the project closes. Not persisted — handles are the
  // source of truth; URLs are a runtime cache.
  objectUrl?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  addedAt: string;
}

export interface TimelineClip {
  id: string;
  mediaId: string; // references MediaItem.id — media is never duplicated
  trimIn: number; // seconds into the source
  trimOut: number; // seconds into the source
  order: number; // position in the single track (v1); float, sparse
}

export interface Timeline {
  id: string;
  name: string;
  clips: TimelineClip[];
}

export interface ProjectSettings {
  resolutionW: number;
  resolutionH: number;
  frameRate: number;
  aspectRatio: string; // "9:16" | "16:9" | "1:1" | "4:5" | custom
}

export interface ChatMessagePart {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  toolUseId?: string;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: ChatMessagePart[];
  createdAt: string;
}
