"use client";

import { create } from "zustand";
import type { MediaItem, Timeline, TimelineClip, Caption, ProjectSettings, ChatMessage, ChatSession, AuthUser } from "./types";
import { DEFAULT_CHAT_MODEL } from "./models";
import { listMediaHandles, buildMediaItem, kindForName } from "./fs";
import { DEFAULT_PIP_RECT } from "./layer-style";
import { saveProjectToDb, loadAllProjectsFromDb, getPersistedActiveProjectId, setPersistedActiveProjectId, type PersistedProject } from "./idb";

// A Project bundles everything that should switch together — library,
// timeline, settings, chat. Session-scoped for now (not persisted across a
// page reload): FileSystemFileHandles are only really safe to reuse within
// the session that requested permission for them without a real handle-
// persistence layer (IndexedDB + permission re-grant flows), which is a
// separate, larger piece of work. Switching between projects you already
// opened this session works fully; closing the tab loses them, same as
// today.
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  folderHandle: FileSystemDirectoryHandle | null;
  // Individually-picked files (via Import, not Open Folder) — there's no
  // directory to re-scan for these, so each file's own handle is kept so
  // it can be reconnected/rebuilt after a reload, the same way a folder's
  // contents are. Only ever empty for browsers without the File System
  // Access API, where "Import" falls back to a plain <input type="file">
  // that genuinely cannot survive a reload.
  looseFileHandles: FileSystemFileHandle[];
  items: MediaItem[];
  timeline: Timeline;
  settings: ProjectSettings;
  messages: ChatMessage[];
  chatHistory: ChatSession[];
  chatModel: string;
}

const defaultSettings: ProjectSettings = {
  resolutionW: 1080,
  resolutionH: 1920,
  frameRate: 30,
  aspectRatio: "9:16",
};

function newProject(name: string): Project {
  return {
    id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt: new Date().toISOString(),
    folderHandle: null,
    looseFileHandles: [],
    items: [],
    timeline: { id: `tl_${Date.now()}`, name: "Timeline 1", clips: [], captions: [] },
    settings: defaultSettings,
    messages: [],
    chatHistory: [],
    chatModel: DEFAULT_CHAT_MODEL,
  };
}

const initialProject = newProject("Untitled Project");

// A generation job in flight (text-to-video, e.g. stock b-roll) — session
// only, not persisted/synced per-project. Generation takes ~2 minutes,
// tracked here so a background poller component can check on it and, on
// completion, import the result and notify in chat without blocking any
// single chat turn (which has its own much shorter time budget).
export interface PendingGeneration {
  id: string;
  requestId: string;
  prompt: string;
  startedAt: string;
}

// What one undo/redo step restores — clips and captions are edited
// somewhat independently, but they share ONE chronological undo history
// (interleaved in true edit order), not two separate stacks, so Cmd+Z
// always reverts whatever you actually did most recently.
interface TimelineSnapshot {
  clips: TimelineClip[];
  captions: Caption[];
}

function snapshotOf(timeline: Timeline): TimelineSnapshot {
  return { clips: timeline.clips, captions: timeline.captions };
}

interface MonkeState {
  // Auth
  user: AuthUser | null;

  // Projects — the active one is mirrored into the top-level fields below
  // (items/timeline/settings/etc.) so every existing component that reads
  // e.g. `s.items` keeps working unchanged; switching projects re-syncs them.
  projects: Project[];
  activeProjectId: string;

  // Active project's data, mirrored from `projects` on every switch
  projectName: string;
  folderHandle: FileSystemDirectoryHandle | null;
  looseFileHandles: FileSystemFileHandle[];
  isLoadingFolder: boolean;
  loadProgress: { done: number; total: number } | null;
  items: MediaItem[];
  selectedItemId: string | null;
  selectedClipId: string | null;
  selectedCaptionId: string | null;
  timeline: Timeline;
  playheadSec: number;
  isPlaying: boolean;
  settings: ProjectSettings;
  messages: ChatMessage[];
  chatHistory: ChatSession[];
  chatModel: string;

  // Timeline undo/redo — per active project, covers clips AND captions together
  timelineUndoStack: TimelineSnapshot[];
  timelineRedoStack: TimelineSnapshot[];

  // Persistence — set once hydrateMonkeStore() has attempted to load saved
  // projects from IndexedDB, so the UI doesn't flash an empty state first.
  hydrated: boolean;
  // True when the active project has a saved folder handle but the browser
  // hasn't (yet) granted permission back to it this session — the user has
  // to click to re-grant (browsers require a user gesture for this).
  folderNeedsReconnect: boolean;

  // In-flight generation jobs — session-only, not persisted.
  pendingGenerations: PendingGeneration[];

  // Panels
  theme: "light" | "dark";

  // Actions
  setUser: (user: AuthUser | null) => void;
  setFolder: (handle: FileSystemDirectoryHandle, name: string) => void;
  setLoadingFolder: (v: boolean) => void;
  setLoadProgress: (p: { done: number; total: number } | null) => void;
  addItem: (item: MediaItem) => void;
  addLooseFileHandle: (handle: FileSystemFileHandle) => void;
  removeItem: (id: string) => void;
  selectItem: (id: string | null) => void;
  selectClip: (id: string | null) => void;
  selectCaption: (id: string | null) => void;
  addTimelineClip: (
    mediaId: string,
    opts?: {
      trimIn?: number;
      trimOut?: number;
      order?: number;
      trackIndex?: number;
      timelineStart?: number;
      position?: TimelineClip["position"];
      opacity?: number;
      mask?: TimelineClip["mask"];
      volume?: number;
      muted?: boolean;
    }
  ) => string;
  updateTimelineClip: (
    clipId: string,
    patch: Partial<Pick<TimelineClip, "trimIn" | "trimOut" | "order" | "trackIndex" | "timelineStart" | "position" | "opacity" | "mask" | "volume" | "muted">>
  ) => void;
  removeTimelineClip: (clipId: string) => void;
  reorderTimelineClip: (clipId: string, order: number) => void;
  splitTimelineClip: (clipId: string, atSeconds: number) => string | null;
  buildSequence: (clips: { mediaId: string; trimIn: number; trimOut: number }[]) => void;
  addCaption: (caption: Omit<Caption, "id">) => string;
  updateCaption: (id: string, patch: Partial<Omit<Caption, "id">>) => void;
  removeCaption: (id: string) => void;
  rescanFolder: () => Promise<void>;
  reconnectFolder: () => Promise<void>;
  maybeAutoRescan: () => Promise<void>;
  undoTimeline: () => void;
  redoTimeline: () => void;
  setPlayhead: (sec: number) => void;
  setIsPlaying: (v: boolean) => void;
  setSettings: (patch: Partial<ProjectSettings>) => void;
  // id/createdAt are generated here, not by the caller — Date.now()/random
  // IDs constructed inside a component body during render are flagged as
  // impure by the React Compiler; store actions run outside render, so
  // it's the right place for this.
  pushMessage: (role: ChatMessage["role"], parts: ChatMessage["parts"]) => ChatMessage;
  clearChat: () => void;
  restoreChatSession: (id: string) => void;
  setChatModel: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  createProject: () => void;
  switchProject: (id: string) => void;
  setTheme: (t: "light" | "dark") => void;
  addPendingGeneration: (requestId: string, prompt: string) => string;
  removePendingGeneration: (id: string) => void;
  reset: () => void;
}

// Folds the live top-level fields back into `projects` for whichever project
// is currently active — the single source-of-truth sync point, mirroring
// the same pattern used for multi-board switching elsewhere in this codebase.
function syncActiveProjectIntoList(s: MonkeState): Project[] {
  return s.projects.map((p) =>
    p.id === s.activeProjectId
      ? {
          ...p,
          name: s.projectName,
          folderHandle: s.folderHandle,
          looseFileHandles: s.looseFileHandles,
          items: s.items,
          timeline: s.timeline,
          settings: s.settings,
          messages: s.messages,
          chatHistory: s.chatHistory,
          chatModel: s.chatModel,
        }
      : p
  );
}

export const useMonkeStore = create<MonkeState>((set, get) => ({
  user: null,
  projects: [initialProject],
  activeProjectId: initialProject.id,
  projectName: initialProject.name,
  folderHandle: null,
  looseFileHandles: [],
  isLoadingFolder: false,
  loadProgress: null,
  items: [],
  selectedItemId: null,
  selectedClipId: null,
  selectedCaptionId: null,
  timeline: initialProject.timeline,
  playheadSec: 0,
  isPlaying: false,
  settings: defaultSettings,
  messages: [],
  chatHistory: [],
  chatModel: DEFAULT_CHAT_MODEL,
  timelineUndoStack: [],
  timelineRedoStack: [],
  hydrated: false,
  folderNeedsReconnect: false,
  pendingGenerations: [],
  theme: "dark",

  setUser: (user) => set({ user }),
  setFolder: (handle, name) => set({ folderHandle: handle, projectName: name }),
  setLoadingFolder: (v) => set({ isLoadingFolder: v }),
  setLoadProgress: (p) => set({ loadProgress: p }),
  addItem: (item) => set((s) => ({ items: [...s.items, item] })),
  // Cascades: any timeline clips referencing this media are removed too
  // (a clip pointing at a deleted item is just broken, not useful to keep
  // around), pushed onto the undo stack like any other timeline mutation.
  removeItem: (id) =>
    set((s) => {
      const removed = s.items.find((i) => i.id === id);
      if (removed?.objectUrl) URL.revokeObjectURL(removed.objectUrl);
      if (removed?.thumbnailUrl && removed.thumbnailUrl !== removed.objectUrl) URL.revokeObjectURL(removed.thumbnailUrl);
      const affectedClips = s.timeline.clips.some((c) => c.mediaId === id);
      return {
        items: s.items.filter((i) => i.id !== id),
        looseFileHandles: removed ? s.looseFileHandles.filter((h) => h.name !== removed.name) : s.looseFileHandles,
        selectedItemId: s.selectedItemId === id ? null : s.selectedItemId,
        timelineUndoStack: affectedClips ? [...s.timelineUndoStack.slice(-49), snapshotOf(s.timeline)] : s.timelineUndoStack,
        timelineRedoStack: affectedClips ? [] : s.timelineRedoStack,
        timeline: affectedClips ? { ...s.timeline, clips: s.timeline.clips.filter((c) => c.mediaId !== id) } : s.timeline,
      };
    }),
  addLooseFileHandle: (handle) => set((s) => ({ looseFileHandles: [...s.looseFileHandles.filter((h) => h.name !== handle.name), handle] })),
  selectItem: (id) => set({ selectedItemId: id }),
  selectClip: (id) => set({ selectedClipId: id }),
  selectCaption: (id) => set({ selectedCaptionId: id }),

  addTimelineClip: (mediaId, opts) => {
    const clipId = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    set((s) => {
      const clips = s.timeline.clips;
      const trackIndex = opts?.trackIndex ?? 0;
      const item = get().items.find((i) => i.id === mediaId);
      const trimIn = opts?.trimIn ?? 0;
      const trimOut = opts?.trimOut ?? item?.durationSec ?? trimIn + 5;
      let newClip: TimelineClip;
      if (trackIndex === 0) {
        // Base track: sequential, ordered — same behavior as before layering existed.
        const maxOrder = clips.filter((c) => (c.trackIndex ?? 0) === 0).reduce((m, c) => Math.max(m, c.order), -1);
        newClip = {
          id: clipId,
          mediaId,
          trimIn,
          trimOut,
          order: opts?.order ?? maxOrder + 1,
          trackIndex: 0,
          volume: opts?.volume,
          muted: opts?.muted,
        };
      } else {
        // Overlay track: floats at an explicit timeline position, independent of base-track sequencing.
        newClip = {
          id: clipId,
          mediaId,
          trimIn,
          trimOut,
          order: 0,
          trackIndex,
          timelineStart: Math.max(0, opts?.timelineStart ?? 0),
          position: opts?.position ?? DEFAULT_PIP_RECT,
          opacity: opts?.opacity,
          mask: opts?.mask,
          // Overlays default to muted — surfacing a second audio track
          // under the base clip's own sound is rarely what's wanted;
          // explicit muted:false (via update_caption/update_timeline_clip's
          // muted field) opts back in.
          volume: opts?.volume,
          muted: opts?.muted ?? true,
        };
      }
      return {
        timelineUndoStack: [...s.timelineUndoStack.slice(-49), snapshotOf(s.timeline)],
        timelineRedoStack: [],
        timeline: { ...s.timeline, clips: [...clips, newClip] },
      };
    });
    return clipId;
  },

  updateTimelineClip: (clipId, patch) =>
    set((s) => ({
      timelineUndoStack: [...s.timelineUndoStack.slice(-49), snapshotOf(s.timeline)],
      timelineRedoStack: [],
      timeline: { ...s.timeline, clips: s.timeline.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) },
    })),

  removeTimelineClip: (clipId) =>
    set((s) => ({
      timelineUndoStack: [...s.timelineUndoStack.slice(-49), snapshotOf(s.timeline)],
      timelineRedoStack: [],
      timeline: { ...s.timeline, clips: s.timeline.clips.filter((c) => c.id !== clipId) },
    })),

  reorderTimelineClip: (clipId, order) =>
    set((s) => ({
      timelineUndoStack: [...s.timelineUndoStack.slice(-49), snapshotOf(s.timeline)],
      timelineRedoStack: [],
      timeline: { ...s.timeline, clips: s.timeline.clips.map((c) => (c.id === clipId ? { ...c, order } : c)) },
    })),

  splitTimelineClip: (clipId, atSeconds) => {
    let newClipId: string | null = null;
    set((s) => {
      const clip = s.timeline.clips.find((c) => c.id === clipId);
      if (!clip) return s;
      const splitPoint = clip.trimIn + atSeconds;
      if (splitPoint <= clip.trimIn || splitPoint >= clip.trimOut) return s;
      newClipId = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const first: TimelineClip = { ...clip, trimOut: splitPoint };
      const second: TimelineClip = { ...clip, id: newClipId, trimIn: splitPoint, order: clip.order + 0.5 };
      return {
        timelineUndoStack: [...s.timelineUndoStack.slice(-49), snapshotOf(s.timeline)],
        timelineRedoStack: [],
        timeline: {
          ...s.timeline,
          clips: s.timeline.clips.map((c) => (c.id === clipId ? first : c)).concat(second),
        },
      };
    });
    return newClipId;
  },

  // Replaces the whole timeline in one shot — the efficient path for an
  // agent that's just decided on a cut, instead of N sequential
  // addTimelineClip round-trips.
  buildSequence: (clips) =>
    set((s) => ({
      timelineUndoStack: [...s.timelineUndoStack.slice(-49), snapshotOf(s.timeline)],
      timelineRedoStack: [],
      timeline: {
        ...s.timeline,
        clips: clips.map((c, i) => ({
          id: `clip_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          mediaId: c.mediaId,
          trimIn: c.trimIn,
          trimOut: c.trimOut,
          order: i,
        })),
      },
    })),

  addCaption: (caption) => {
    const id = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      timelineUndoStack: [...s.timelineUndoStack.slice(-49), snapshotOf(s.timeline)],
      timelineRedoStack: [],
      timeline: { ...s.timeline, captions: [...s.timeline.captions, { ...caption, id }] },
    }));
    return id;
  },

  updateCaption: (id, patch) =>
    set((s) => ({
      timelineUndoStack: [...s.timelineUndoStack.slice(-49), snapshotOf(s.timeline)],
      timelineRedoStack: [],
      timeline: { ...s.timeline, captions: s.timeline.captions.map((c) => (c.id === id ? { ...c, ...patch } : c)) },
    })),

  removeCaption: (id) =>
    set((s) => ({
      timelineUndoStack: [...s.timelineUndoStack.slice(-49), snapshotOf(s.timeline)],
      timelineRedoStack: [],
      timeline: { ...s.timeline, captions: s.timeline.captions.filter((c) => c.id !== id) },
      selectedCaptionId: s.selectedCaptionId === id ? null : s.selectedCaptionId,
    })),

  // Rebuilds the whole media library from every known source: the saved
  // folder (if any) plus every individually-imported file handle. Used
  // after hydration (permission still granted) and after reconnectFolder()
  // regrants it. Media ids are deterministic from filename, so a
  // persisted Timeline's clips still resolve against the freshly rebuilt
  // items. Per-handle failures (permission still not granted, file moved)
  // are skipped rather than aborting the whole rebuild — whatever IS
  // reachable still shows up.
  rescanFolder: async () => {
    const s = get();
    if (!s.folderHandle && s.looseFileHandles.length === 0) return;
    set({ isLoadingFolder: true, items: [] });
    try {
      const folderHandles = s.folderHandle ? await listMediaHandles(s.folderHandle).catch(() => []) : [];
      const looseHandles = s.looseFileHandles
        .map((handle) => ({ handle, kind: kindForName(handle.name) }))
        .filter((h): h is { handle: FileSystemFileHandle; kind: NonNullable<ReturnType<typeof kindForName>> } => h.kind !== null);
      const allHandles = [...folderHandles, ...looseHandles];
      set({ loadProgress: { done: 0, total: allHandles.length } });
      for (let i = 0; i < allHandles.length; i++) {
        try {
          const item = await buildMediaItem(allHandles[i].handle, allHandles[i].kind);
          set((st) => ({ items: [...st.items, item] }));
        } catch (err) {
          console.error(`Skipped "${allHandles[i].handle.name}" during rebuild:`, err);
        }
        set({ loadProgress: { done: i + 1, total: allHandles.length } });
      }
    } finally {
      set({ isLoadingFolder: false, loadProgress: null });
    }
  },

  // Must run inside a user gesture (button click) — browsers require that
  // to re-grant a File System Access permission that lapsed between
  // sessions. Requests every known handle (folder + loose files) in one
  // go so a single click covers everything, rather than nagging per-file.
  reconnectFolder: async () => {
    const s = get();
    try {
      if (s.folderHandle) await s.folderHandle.requestPermission({ mode: "readwrite" });
      for (const handle of s.looseFileHandles) {
        await handle.requestPermission({ mode: "readwrite" }).catch(() => "denied");
      }
      await get().rescanFolder();
      set({ folderNeedsReconnect: false });
    } catch (err) {
      console.error("Failed to reconnect:", err);
    }
  },

  // Called after switching/creating/hydrating into a project whose items
  // haven't been loaded yet this session — silently re-scans whatever
  // already has permission, and flags for a manual reconnect click if
  // anything (folder or a loose file) still needs re-granting.
  maybeAutoRescan: async () => {
    const s = get();
    const hasSources = !!s.folderHandle || s.looseFileHandles.length > 0;
    if (!hasSources || s.items.length > 0 || s.isLoadingFolder) return;
    try {
      const checks = await Promise.all([
        s.folderHandle ? s.folderHandle.queryPermission({ mode: "readwrite" }) : Promise.resolve("granted" as const),
        ...s.looseFileHandles.map((h) => h.queryPermission({ mode: "readwrite" })),
      ]);
      const allGranted = checks.every((p) => p === "granted");
      await get().rescanFolder();
      set({ folderNeedsReconnect: !allGranted });
    } catch {
      set({ folderNeedsReconnect: true });
    }
  },

  undoTimeline: () =>
    set((s) => {
      if (s.timelineUndoStack.length === 0) return s;
      const prev = s.timelineUndoStack[s.timelineUndoStack.length - 1];
      return {
        timelineUndoStack: s.timelineUndoStack.slice(0, -1),
        timelineRedoStack: [...s.timelineRedoStack, snapshotOf(s.timeline)],
        timeline: { ...s.timeline, clips: prev.clips, captions: prev.captions },
      };
    }),

  redoTimeline: () =>
    set((s) => {
      if (s.timelineRedoStack.length === 0) return s;
      const next = s.timelineRedoStack[s.timelineRedoStack.length - 1];
      return {
        timelineRedoStack: s.timelineRedoStack.slice(0, -1),
        timelineUndoStack: [...s.timelineUndoStack, snapshotOf(s.timeline)],
        timeline: { ...s.timeline, clips: next.clips, captions: next.captions },
      };
    }),

  setPlayhead: (sec) => set({ playheadSec: sec }),
  setIsPlaying: (v) => set({ isPlaying: v }),
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  pushMessage: (role, parts) => {
    const msg: ChatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role,
      parts,
      createdAt: new Date().toISOString(),
    };
    set((s) => ({ messages: [...s.messages, msg] }));
    return msg;
  },
  // Archives the current conversation (if non-empty) before wiping it, so
  // "New chat" isn't destructive — History can reopen it. Frame images are
  // stripped for the archive, same as the debounced auto-save does for the
  // live conversation (large, re-derivable, not worth keeping around).
  clearChat: () =>
    set((s) => {
      if (s.messages.length === 0) return { messages: [] };
      const archived: ChatSession = {
        id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        messages: s.messages.map((m) => ({ ...m, parts: m.parts.map((part) => ({ ...part, imageDataUrls: undefined })) })),
        endedAt: new Date().toISOString(),
      };
      return { messages: [], chatHistory: [archived, ...s.chatHistory].slice(0, 30) };
    }),
  restoreChatSession: (id) =>
    set((s) => {
      const session = s.chatHistory.find((h) => h.id === id);
      if (!session) return s;
      const rest = s.chatHistory.filter((h) => h.id !== id);
      const withCurrentArchived =
        s.messages.length > 0
          ? [
              {
                id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                messages: s.messages,
                endedAt: new Date().toISOString(),
              },
              ...rest,
            ]
          : rest;
      return { messages: session.messages, chatHistory: withCurrentArchived.slice(0, 30) };
    }),
  setChatModel: (id) => set({ chatModel: id }),

  renameProject: (id, name) =>
    set((s) => ({
      projectName: id === s.activeProjectId ? name : s.projectName,
      projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
    })),

  createProject: () => {
    set((s) => {
      const synced = syncActiveProjectIntoList(s);
      const fresh = newProject(`Untitled Project ${synced.length + 1}`);
      return {
        projects: [...synced, fresh],
        activeProjectId: fresh.id,
        projectName: fresh.name,
        folderHandle: fresh.folderHandle,
        looseFileHandles: fresh.looseFileHandles,
        items: fresh.items,
        selectedItemId: null,
        selectedClipId: null,
        selectedCaptionId: null,
        timeline: fresh.timeline,
        settings: fresh.settings,
        messages: fresh.messages,
        chatHistory: fresh.chatHistory,
        chatModel: fresh.chatModel,
        playheadSec: 0,
        isPlaying: false,
        timelineUndoStack: [],
        timelineRedoStack: [],
        folderNeedsReconnect: false,
      };
    });
  },

  switchProject: (id) => {
    set((s) => {
      if (id === s.activeProjectId) return s;
      const synced = syncActiveProjectIntoList(s);
      const target = synced.find((p) => p.id === id);
      if (!target) return s;
      return {
        projects: synced,
        activeProjectId: id,
        projectName: target.name,
        folderHandle: target.folderHandle,
        looseFileHandles: target.looseFileHandles,
        items: target.items,
        selectedItemId: null,
        selectedClipId: null,
        selectedCaptionId: null,
        timeline: target.timeline,
        settings: target.settings,
        messages: target.messages,
        chatHistory: target.chatHistory,
        chatModel: target.chatModel,
        playheadSec: 0,
        isPlaying: false,
        timelineUndoStack: [],
        timelineRedoStack: [],
        folderNeedsReconnect: false,
      };
    });
    get().maybeAutoRescan();
  },

  setTheme: (t) => set({ theme: t }),
  addPendingGeneration: (requestId, prompt) => {
    const id = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({ pendingGenerations: [...s.pendingGenerations, { id, requestId, prompt, startedAt: new Date().toISOString() }] }));
    return id;
  },
  removePendingGeneration: (id) => set((s) => ({ pendingGenerations: s.pendingGenerations.filter((g) => g.id !== id) })),
  reset: () =>
    set({
      projectName: "Untitled Project",
      folderHandle: null,
      items: [],
      selectedItemId: null,
      selectedClipId: null,
      selectedCaptionId: null,
      timeline: { id: "tl_1", name: "Timeline 1", clips: [], captions: [] },
      playheadSec: 0,
      isPlaying: false,
      messages: [],
      timelineUndoStack: [],
      timelineRedoStack: [],
    }),
}));

// --- Auto-save --------------------------------------------------------
// Debounced: any change to the fields that matter gets folded into
// `projects` and written to IndexedDB shortly after. Media bytes never
// leave disk — only the folder handle reference, timeline, settings, and
// chat history are persisted, so a reload/redeploy restores the project
// without re-uploading anything. Frame images captured by
// timeline_probe_clip are stripped before saving (large, and re-derivable
// on demand) — only the surrounding text/tool-call record is kept.
function stripImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({ ...m, parts: m.parts.map((part) => ({ ...part, imageDataUrls: undefined })) }));
}

async function persistNow(state: MonkeState): Promise<void> {
  const list = syncActiveProjectIntoList(state);
  for (const p of list) {
    const persisted: PersistedProject = {
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      folderHandle: p.folderHandle,
      looseFileHandles: p.looseFileHandles,
      timeline: p.timeline,
      settings: p.settings,
      messages: stripImages(p.messages),
      chatHistory: p.chatHistory.map((h) => ({ ...h, messages: stripImages(h.messages) })),
      chatModel: p.chatModel,
    };
    try {
      await saveProjectToDb(persisted);
    } catch (err) {
      // FileSystemDirectoryHandle/FileSystemFileHandle are spec-cloneable
      // but not every browser build honors that reliably inside an
      // IndexedDB transaction — if the write fails with handles attached,
      // retry without them rather than losing the whole project
      // (timeline/chat/settings are still worth keeping; the user just
      // re-imports the media).
      console.error("Failed to save project, retrying without file handles:", err);
      try {
        await saveProjectToDb({ ...persisted, folderHandle: null, looseFileHandles: [] });
      } catch (err2) {
        console.error("Failed to save project at all:", err2);
      }
    }
  }
  setPersistedActiveProjectId(state.activeProjectId);
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(state: MonkeState) {
  if (typeof window === "undefined") return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow(state);
  }, 400);
}

function relevantFieldsChanged(state: MonkeState, prev: MonkeState): boolean {
  return (
    state.projects !== prev.projects ||
    state.activeProjectId !== prev.activeProjectId ||
    state.projectName !== prev.projectName ||
    state.folderHandle !== prev.folderHandle ||
    state.timeline !== prev.timeline ||
    state.settings !== prev.settings ||
    state.messages !== prev.messages ||
    state.chatHistory !== prev.chatHistory ||
    state.chatModel !== prev.chatModel
  );
}

if (typeof window !== "undefined") {
  useMonkeStore.subscribe((state, prev) => {
    if (!state.hydrated) return; // don't stomp saved data with pre-hydration defaults
    if (relevantFieldsChanged(state, prev)) schedulePersist(state);
  });

  // A 400ms debounce timer is lost outright if the page unloads before it
  // fires — "do something, then immediately refresh/close" would silently
  // drop that last change. Flush immediately (persistTimer !== null means
  // a save is pending) whenever the page is about to go away, instead of
  // only on the debounce.
  const flushOnHide = () => {
    if (persistTimer === null) return;
    clearTimeout(persistTimer);
    persistTimer = null;
    void persistNow(useMonkeStore.getState());
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnHide();
  });
  window.addEventListener("pagehide", flushOnHide);
}

// --- Hydration ----------------------------------------------------------
// Call once on app mount (after auth succeeds). Loads any saved projects
// from IndexedDB, restores them into the store, and — for the active
// project — attempts a silent folder re-scan if permission is still
// granted (it often is, within the same browser profile).
export async function hydrateMonkeStore(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const persisted = await loadAllProjectsFromDb();
    if (persisted.length === 0) {
      useMonkeStore.setState({ hydrated: true });
      return;
    }
    const projects: Project[] = persisted.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      folderHandle: p.folderHandle,
      looseFileHandles: p.looseFileHandles ?? [],
      items: [],
      // Older persisted records predate captions — default so nothing
      // downstream has to null-check timeline.captions.
      timeline: { ...p.timeline, captions: p.timeline.captions ?? [] },
      settings: p.settings,
      messages: p.messages,
      chatHistory: p.chatHistory ?? [],
      chatModel: p.chatModel,
    }));
    const savedActiveId = getPersistedActiveProjectId();
    const active = projects.find((p) => p.id === savedActiveId) ?? projects[0];
    useMonkeStore.setState({
      projects,
      activeProjectId: active.id,
      projectName: active.name,
      folderHandle: active.folderHandle,
      looseFileHandles: active.looseFileHandles,
      items: [],
      timeline: active.timeline,
      settings: active.settings,
      messages: active.messages,
      chatHistory: active.chatHistory,
      chatModel: active.chatModel,
      hydrated: true,
    });
    await useMonkeStore.getState().maybeAutoRescan();
  } catch (err) {
    console.error("Failed to hydrate from IndexedDB:", err);
    useMonkeStore.setState({ hydrated: true });
  }
}
