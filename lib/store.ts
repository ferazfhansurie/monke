"use client";

import { create } from "zustand";
import type { MediaItem, Timeline, TimelineClip, Caption, ProjectSettings, ChatMessage, ChatSession, AuthUser } from "./types";
import { DEFAULT_CHAT_MODEL } from "./models";
import { listMediaHandles, buildMediaItem, kindForName, restoreGeneratedClip } from "./fs";
import { DEFAULT_PIP_RECT } from "./layer-style";
import { saveProjectToDb, loadAllProjectsFromDb, getPersistedActiveProjectId, setPersistedActiveProjectId, type PersistedProject } from "./idb";
import { readWorkspace, writeWorkspace, type WorkspaceFile } from "./workspace";

// Imported lazily: lib/segmentation.ts pulls in onnxruntime-web, and the
// store is loaded on every page — no reason to drag the ML runtime in just
// to free some blob URLs.
async function releaseCutoutFrames(result: import("./segmentation").CutoutResult) {
  const { releaseCutout } = await import("./segmentation");
  releaseCutout(result);
}

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
  // Generated clips (generate_stock_clip) have no on-disk file — their
  // bytes are kept here so they survive a reload, unlike a handle which
  // has nothing to reconnect to. See PersistedGeneratedClip in lib/idb.ts.
  generatedClips: GeneratedClipRecord[];
  items: MediaItem[];
  timeline: Timeline;
  settings: ProjectSettings;
  messages: ChatMessage[];
  chatHistory: ChatSession[];
  chatModel: string;
}

export interface GeneratedClipRecord {
  id: string;
  name: string;
  blob: Blob;
  addedAt: string;
}

// What opening a folder actually did — surfaced in the UI so a project
// switch is never invisible. "resumed" is the VSCode-like case: this exact
// folder was already a project, so its timeline AND chat history come back
// with it.
export type OpenFolderOutcome =
  | { action: "resumed"; projectName: string; pastConversations: number; hasLiveConversation: boolean }
  | { action: "rescanned"; projectName: string }
  | { action: "attached"; projectName: string }
  | { action: "created"; projectName: string };


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
    generatedClips: [],
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

// A copy of a clip with a fresh identity, placed so it doesn't sit exactly
// on top of the original: base-track copies append to the end of the track,
// overlays offset by their own length.
function cloneClip(clip: TimelineClip, allClips: TimelineClip[], index: number): TimelineClip {
  const id = `clip_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`;
  if ((clip.trackIndex ?? 0) === 0) {
    const maxOrder = allClips.filter((c) => (c.trackIndex ?? 0) === 0).reduce((m, c) => Math.max(m, c.order), -1);
    return { ...clip, id, order: maxOrder + 1 + index };
  }
  const span = Math.max(0, clip.trimOut - clip.trimIn) / (clip.speed && clip.speed > 0 ? clip.speed : 1);
  return { ...clip, id, timelineStart: (clip.timelineStart ?? 0) + span };
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
  generatedClips: GeneratedClipRecord[];
  isLoadingFolder: boolean;
  loadProgress: { done: number; total: number } | null;
  items: MediaItem[];
  selectedItemId: string | null;
  selectedClipId: string | null;
  // Every selected clip, for bulk actions. selectedClipId stays the primary
  // (what the inspector edits) so single-selection behaviour is unchanged.
  selectedClipIds: string[];
  // Session-only clipboard — copied clips, not media.
  clipboard: TimelineClip[];
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

  // Baked person-cutout alpha frames, keyed by timeline clip id — session
  // only, deliberately not persisted (a few hundred PNG frames per clip
  // would bloat IndexedDB substantially for something that's cheap enough
  // to re-bake). The clip's own `cutout` boolean (persisted, on the clip
  // itself) survives a reload; the actual matte data doesn't, so it needs
  // re-baking after one — same trade-off decodedCache makes in lib/audio.ts.
  cutoutFrames: Record<string, import("./segmentation").CutoutResult>;

  // Panels
  theme: "light" | "dark";

  // Actions
  setUser: (user: AuthUser | null) => void;
  setFolder: (handle: FileSystemDirectoryHandle, name: string) => void;
  setLoadingFolder: (v: boolean) => void;
  setLoadProgress: (p: { done: number; total: number } | null) => void;
  addItem: (item: MediaItem) => void;
  addLooseFileHandle: (handle: FileSystemFileHandle) => void;
  // Generated clips need their bytes persisted directly (no on-disk file to
  // reconnect to on reload) — call alongside addItem whenever a clip comes
  // from generate_stock_clip, not for handle-backed media.
  addGeneratedClip: (item: MediaItem) => Promise<void>;
  removeItem: (id: string) => void;
  selectItem: (id: string | null) => void;
  selectClip: (id: string | null) => void;
  toggleClipSelection: (id: string) => void;
  duplicateClips: (ids: string[]) => void;
  copyClips: (ids: string[]) => void;
  pasteClips: (atSeconds: number) => void;
  removeTimelineClips: (ids: string[]) => void;
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
    patch: Partial<Pick<TimelineClip, "trimIn" | "trimOut" | "order" | "trackIndex" | "timelineStart" | "position" | "opacity" | "mask" | "volume" | "muted" | "cutout" | "speed" | "fadeInSec" | "fadeOutSec">>
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
  findProjectByFolder: (dir: FileSystemDirectoryHandle) => Promise<string | null>;
  openFolder: (dir: FileSystemDirectoryHandle) => Promise<OpenFolderOutcome>;
  setTheme: (t: "light" | "dark") => void;
  addPendingGeneration: (requestId: string, prompt: string) => string;
  removePendingGeneration: (id: string) => void;
  setCutoutFrames: (clipId: string, result: import("./segmentation").CutoutResult) => void;
  clearCutoutFrames: (clipId: string) => void;
  reset: () => void;
}

const MAX_ARCHIVED_CONVERSATIONS = 30;

// Union of the conversations this browser knows about and the ones the
// folder itself carries, newest first. Deduped by id, preferring the local
// copy (it's the one that may have unsaved edits). This is what makes the
// same folder opened on a second machine end up with BOTH machines'
// conversations rather than whichever one saved last.
function mergeConversations(local: ChatSession[], fromFolder: ChatSession[]): ChatSession[] {
  const byId = new Map<string, ChatSession>();
  for (const c of fromFolder) if (c.messages.length > 0) byId.set(c.id, c);
  for (const c of local) if (c.messages.length > 0) byId.set(c.id, c);
  return [...byId.values()]
    .sort((a, b) => new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime())
    .slice(0, MAX_ARCHIVED_CONVERSATIONS);
}

// The conversation that was open in the folder last time becomes an
// archived one on reopen, so everything a folder has ever held shows up in
// one place (the History list) instead of some of it silently replacing
// whatever chat is currently on screen.
//
// `skipIfMatches` is the chat currently on screen: reopening the folder
// you're already in reads back the sidecar you just wrote, whose live
// conversation IS that chat — archiving it would clone the open
// conversation into History. Keying the id off the last message (rather
// than the save timestamp) also makes repeated merges idempotent.
function archiveLiveConversation(ws: WorkspaceFile, skipIfMatches: ChatMessage[] = []): ChatSession[] {
  if (ws.liveConversation.length === 0) return [];
  const lastId = ws.liveConversation[ws.liveConversation.length - 1]?.id;
  if (lastId && lastId === skipIfMatches[skipIfMatches.length - 1]?.id) return [];
  return [{ id: `chat_ws_${lastId ?? ws.updatedAt}`, messages: ws.liveConversation, endedAt: ws.updatedAt }];
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
          generatedClips: s.generatedClips,
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
  generatedClips: [],
  isLoadingFolder: false,
  loadProgress: null,
  items: [],
  selectedItemId: null,
  selectedClipId: null,
  selectedClipIds: [],
  clipboard: [],
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
  cutoutFrames: {},
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
  addGeneratedClip: async (item) => {
    const blob = await item.handle.getFile();
    set((s) => ({
      generatedClips: [...s.generatedClips.filter((g) => g.id !== item.id), { id: item.id, name: item.name, blob, addedAt: item.addedAt }],
    }));
  },
  selectItem: (id) => set({ selectedItemId: id }),
  selectClip: (id) => set({ selectedClipId: id, selectedClipIds: id ? [id] : [] }),

  toggleClipSelection: (id) =>
    set((s) => {
      const has = s.selectedClipIds.includes(id);
      const next = has ? s.selectedClipIds.filter((x) => x !== id) : [...s.selectedClipIds, id];
      // Primary follows the newest addition; on removal it falls back to
      // whatever is still selected so the inspector never points at nothing.
      return { selectedClipIds: next, selectedClipId: has ? next[next.length - 1] ?? null : id };
    }),

  duplicateClips: (ids) =>
    set((s) => {
      const originals = s.timeline.clips.filter((c) => ids.includes(c.id));
      if (originals.length === 0) return s;
      const copies = originals.map((c, i) => cloneClip(c, s.timeline.clips, i));
      return {
        timelineUndoStack: [...s.timelineUndoStack.slice(-49), snapshotOf(s.timeline)],
        timelineRedoStack: [],
        timeline: { ...s.timeline, clips: [...s.timeline.clips, ...copies] },
        selectedClipIds: copies.map((c) => c.id),
        selectedClipId: copies[copies.length - 1]?.id ?? null,
      };
    }),

  copyClips: (ids) => set((s) => ({ clipboard: s.timeline.clips.filter((c) => ids.includes(c.id)) })),

  pasteClips: (atSeconds) =>
    set((s) => {
      if (s.clipboard.length === 0) return s;
      // Base-track pastes append (the track is sequential, so "at the
      // playhead" isn't meaningful); overlays land at the playhead.
      const pasted = s.clipboard.map((c, i) =>
        (c.trackIndex ?? 0) === 0
          ? cloneClip(c, s.timeline.clips, i)
          : { ...cloneClip(c, s.timeline.clips, i), timelineStart: Math.max(0, atSeconds) }
      );
      return {
        timelineUndoStack: [...s.timelineUndoStack.slice(-49), snapshotOf(s.timeline)],
        timelineRedoStack: [],
        timeline: { ...s.timeline, clips: [...s.timeline.clips, ...pasted] },
        selectedClipIds: pasted.map((c) => c.id),
        selectedClipId: pasted[pasted.length - 1]?.id ?? null,
      };
    }),

  removeTimelineClips: (ids) =>
    set((s) => ({
      timelineUndoStack: [...s.timelineUndoStack.slice(-49), snapshotOf(s.timeline)],
      timelineRedoStack: [],
      timeline: { ...s.timeline, clips: s.timeline.clips.filter((c) => !ids.includes(c.id)) },
      selectedClipIds: [],
      selectedClipId: null,
    })),
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
    if (!s.folderHandle && s.looseFileHandles.length === 0 && s.generatedClips.length === 0) return;
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
      // Generated clips have no handle to reconnect — rebuild straight from
      // their persisted bytes instead of a permission-gated file read.
      for (const g of s.generatedClips) {
        try {
          const item = await restoreGeneratedClip(g.blob, g.name);
          set((st) => ({ items: [...st.items, item] }));
        } catch (err) {
          console.error(`Skipped generated clip "${g.name}" during rebuild:`, err);
        }
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
    const hasSources = !!s.folderHandle || s.looseFileHandles.length > 0 || s.generatedClips.length > 0;
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
        generatedClips: fresh.generatedClips,
        items: fresh.items,
        selectedItemId: null,
        selectedClipId: null,
        selectedClipIds: [],
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
        generatedClips: target.generatedClips,
        items: target.items,
        selectedItemId: null,
        selectedClipId: null,
        selectedClipIds: [],
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
  // Opening a folder that's already the source of a DIFFERENT existing
  // project should resume that project (its chat history, timeline,
  // everything) rather than silently attaching the same folder to whatever
  // project happens to be active right now — the VSCode/`claude --resume`
  // behavior of "reopening a workspace picks up where you left off".
  // isSameEntry compares actual underlying-file identity, not just a name
  // match (two different folders can share a name; a moved/renamed folder
  // handle can still be the same entry) — the correct comparison per spec.
  findProjectByFolder: async (dir) => {
    const projects = syncActiveProjectIntoList(get());
    for (const p of projects) {
      if (!p.folderHandle) continue;
      try {
        if (await p.folderHandle.isSameEntry(dir)) return p.id;
      } catch {
        // A handle from a since-deleted/permission-revoked folder can throw
        // on comparison — not a match, keep looking rather than aborting.
      }
    }
    return null;
  },

  // The whole "Open Folder" decision, in one place. Previously this just did
  // setFolder() unconditionally, which meant opening ANY new folder renamed
  // the currently-active project and attached the new media to it while
  // keeping the old project's timeline and chat — silently merging two
  // unrelated pieces of work. Mirrors how an editor treats opening a
  // workspace instead: a known folder reopens ITS project (timeline + chat
  // history included), a new folder gets its own.
  openFolder: async (dir) => {
    // The folder's own record first — this is what makes reopening footage
    // anywhere (new browser, new machine, after clearing site data) still
    // offer its conversations, instead of them existing only in this
    // browser's IndexedDB.
    const ws = await readWorkspace(dir);
    const existingId = await get().findProjectByFolder(dir);

    if (existingId) {
      if (existingId !== get().activeProjectId) {
        get().switchProject(existingId); // also triggers maybeAutoRescan
        // Fold in anything the folder itself carries that this browser
        // doesn't have — e.g. conversations from another machine that
        // worked on the same footage. The live chat stays as-is here; this
        // project's own is already the fresher one.
        if (ws) {
          set((prev) => ({ chatHistory: mergeConversations(prev.chatHistory, [...archiveLiveConversation(ws, prev.messages), ...ws.conversations]) }));
        }
        const resumed = get();
        return {
          action: "resumed",
          projectName: resumed.projectName,
          pastConversations: resumed.chatHistory.length,
          hasLiveConversation: resumed.messages.length > 0,
        };
      }
      // Already the active project — refresh its media, and still fold in
      // any conversations the folder carries that this browser lacks (it
      // may have been worked on elsewhere since). Reopening the folder
      // you're already in is the most common way to ask for exactly that.
      if (ws) {
        set((prev) => ({ chatHistory: mergeConversations(prev.chatHistory, [...archiveLiveConversation(ws, prev.messages), ...ws.conversations]) }));
      }
      await get().rescanFolder();
      return { action: "rescanned", projectName: get().projectName };
    }

    // A brand-new folder. Only fold it into the current project if that
    // project is genuinely untouched (a fresh/empty workspace) — otherwise
    // give it its own, so existing work is never absorbed into it.
    const s = get();
    const currentIsEmpty =
      !s.folderHandle &&
      s.looseFileHandles.length === 0 &&
      s.generatedClips.length === 0 &&
      s.items.length === 0 &&
      s.timeline.clips.length === 0 &&
      s.messages.length === 0 &&
      s.chatHistory.length === 0;

    if (currentIsEmpty) {
      set({ folderHandle: dir, projectName: dir.name });
      await get().rescanFolder();
      return { action: "attached", projectName: dir.name };
    }

    set((prev) => {
      const synced = syncActiveProjectIntoList(prev);
      // Seed the new project from the folder's own workspace file when it
      // has one — that's the whole point of the sidecar: this browser has
      // never seen this folder, but the folder remembers its own work.
      const base = newProject(ws?.projectName?.trim() || dir.name);
      const fresh: Project = {
        ...base,
        folderHandle: dir,
        timeline: ws?.timeline ? { ...ws.timeline, captions: ws.timeline.captions ?? [] } : base.timeline,
        settings: ws?.settings ?? base.settings,
        // Everything the folder carries lands in History (including the
        // chat that was open there last time) and the panel opens on a
        // clean chat — so reopening a folder never silently swaps out
        // what's on screen, and nothing is hidden behind a prompt.
        messages: base.messages,
        chatHistory: ws ? mergeConversations([], [...archiveLiveConversation(ws), ...ws.conversations]) : base.chatHistory,
        chatModel: ws?.chatModel ?? base.chatModel,
      };
      return {
        projects: [...synced, fresh],
        activeProjectId: fresh.id,
        projectName: fresh.name,
        folderHandle: fresh.folderHandle,
        looseFileHandles: fresh.looseFileHandles,
        generatedClips: fresh.generatedClips,
        items: fresh.items,
        selectedItemId: null,
        selectedClipId: null,
        selectedClipIds: [],
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
    await get().rescanFolder();
    if (ws) {
      const resumed = get();
      return {
        action: "resumed",
        projectName: resumed.projectName,
        pastConversations: resumed.chatHistory.length,
        hasLiveConversation: resumed.messages.length > 0,
      };
    }
    return { action: "created", projectName: dir.name };
  },

  setTheme: (t) => set({ theme: t }),
  addPendingGeneration: (requestId, prompt) => {
    const id = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({ pendingGenerations: [...s.pendingGenerations, { id, requestId, prompt, startedAt: new Date().toISOString() }] }));
    return id;
  },
  removePendingGeneration: (id) => set((s) => ({ pendingGenerations: s.pendingGenerations.filter((g) => g.id !== id) })),
  setCutoutFrames: (clipId, result) =>
    set((s) => {
      // Re-baking a clip strands the previous matte's blob URLs unless they
      // are explicitly revoked — the browser holds those bytes until then.
      if (s.cutoutFrames[clipId]) void releaseCutoutFrames(s.cutoutFrames[clipId]);
      return { cutoutFrames: { ...s.cutoutFrames, [clipId]: result } };
    }),
  clearCutoutFrames: (clipId) =>
    set((s) => {
      if (s.cutoutFrames[clipId]) void releaseCutoutFrames(s.cutoutFrames[clipId]);
      return { cutoutFrames: Object.fromEntries(Object.entries(s.cutoutFrames).filter(([id]) => id !== clipId)) };
    }),
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
      generatedClips: p.generatedClips,
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

  // Mirror the ACTIVE project into its own folder as .monke/workspace.json,
  // so its conversations/timeline are recoverable from the footage itself
  // rather than only from this browser's IndexedDB. Best-effort: a failure
  // here (permission lapsed, read-only volume) is logged inside
  // writeWorkspace and never interrupts the IndexedDB save above.
  if (state.folderHandle) {
    await writeWorkspace(state.folderHandle, {
      projectName: state.projectName,
      liveConversation: state.messages,
      conversations: state.chatHistory,
      timeline: state.timeline,
      settings: state.settings,
      chatModel: state.chatModel,
    });
  }
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
    state.generatedClips !== prev.generatedClips ||
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
      generatedClips: p.generatedClips ?? [],
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
      generatedClips: active.generatedClips,
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
