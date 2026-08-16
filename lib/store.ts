"use client";

import { create } from "zustand";
import type { MediaItem, Timeline, TimelineClip, ProjectSettings, ChatMessage, AuthUser } from "./types";
import { DEFAULT_CHAT_MODEL } from "./models";

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
  items: MediaItem[];
  timeline: Timeline;
  settings: ProjectSettings;
  messages: ChatMessage[];
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
    items: [],
    timeline: { id: `tl_${Date.now()}`, name: "Timeline 1", clips: [] },
    settings: defaultSettings,
    messages: [],
    chatModel: DEFAULT_CHAT_MODEL,
  };
}

const initialProject = newProject("Untitled Project");

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
  isLoadingFolder: boolean;
  loadProgress: { done: number; total: number } | null;
  items: MediaItem[];
  selectedItemId: string | null;
  timeline: Timeline;
  playheadSec: number;
  isPlaying: boolean;
  settings: ProjectSettings;
  messages: ChatMessage[];
  chatModel: string;

  // Timeline undo/redo — per active project's clip list
  timelineUndoStack: TimelineClip[][];
  timelineRedoStack: TimelineClip[][];

  // Panels
  theme: "light" | "dark";

  // Actions
  setUser: (user: AuthUser | null) => void;
  setFolder: (handle: FileSystemDirectoryHandle, name: string) => void;
  setLoadingFolder: (v: boolean) => void;
  setLoadProgress: (p: { done: number; total: number } | null) => void;
  addItem: (item: MediaItem) => void;
  selectItem: (id: string | null) => void;
  addTimelineClip: (mediaId: string, opts?: { trimIn?: number; trimOut?: number; order?: number }) => string;
  updateTimelineClip: (clipId: string, patch: Partial<Pick<TimelineClip, "trimIn" | "trimOut" | "order">>) => void;
  removeTimelineClip: (clipId: string) => void;
  reorderTimelineClip: (clipId: string, order: number) => void;
  splitTimelineClip: (clipId: string, atSeconds: number) => string | null;
  buildSequence: (clips: { mediaId: string; trimIn: number; trimOut: number }[]) => void;
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
  setChatModel: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  createProject: () => void;
  switchProject: (id: string) => void;
  setTheme: (t: "light" | "dark") => void;
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
          items: s.items,
          timeline: s.timeline,
          settings: s.settings,
          messages: s.messages,
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
  isLoadingFolder: false,
  loadProgress: null,
  items: [],
  selectedItemId: null,
  timeline: initialProject.timeline,
  playheadSec: 0,
  isPlaying: false,
  settings: defaultSettings,
  messages: [],
  chatModel: DEFAULT_CHAT_MODEL,
  timelineUndoStack: [],
  timelineRedoStack: [],
  theme: "dark",

  setUser: (user) => set({ user }),
  setFolder: (handle, name) => set({ folderHandle: handle, projectName: name }),
  setLoadingFolder: (v) => set({ isLoadingFolder: v }),
  setLoadProgress: (p) => set({ loadProgress: p }),
  addItem: (item) => set((s) => ({ items: [...s.items, item] })),
  selectItem: (id) => set({ selectedItemId: id }),

  addTimelineClip: (mediaId, opts) => {
    const clipId = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    set((s) => {
      const clips = s.timeline.clips;
      const maxOrder = clips.reduce((m, c) => Math.max(m, c.order), -1);
      const item = get().items.find((i) => i.id === mediaId);
      const trimIn = opts?.trimIn ?? 0;
      const trimOut = opts?.trimOut ?? item?.durationSec ?? trimIn + 5;
      const newClip: TimelineClip = {
        id: clipId,
        mediaId,
        trimIn,
        trimOut,
        order: opts?.order ?? maxOrder + 1,
      };
      return {
        timelineUndoStack: [...s.timelineUndoStack.slice(-49), clips],
        timelineRedoStack: [],
        timeline: { ...s.timeline, clips: [...clips, newClip] },
      };
    });
    return clipId;
  },

  updateTimelineClip: (clipId, patch) =>
    set((s) => ({
      timelineUndoStack: [...s.timelineUndoStack.slice(-49), s.timeline.clips],
      timelineRedoStack: [],
      timeline: { ...s.timeline, clips: s.timeline.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) },
    })),

  removeTimelineClip: (clipId) =>
    set((s) => ({
      timelineUndoStack: [...s.timelineUndoStack.slice(-49), s.timeline.clips],
      timelineRedoStack: [],
      timeline: { ...s.timeline, clips: s.timeline.clips.filter((c) => c.id !== clipId) },
    })),

  reorderTimelineClip: (clipId, order) =>
    set((s) => ({
      timelineUndoStack: [...s.timelineUndoStack.slice(-49), s.timeline.clips],
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
        timelineUndoStack: [...s.timelineUndoStack.slice(-49), s.timeline.clips],
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
      timelineUndoStack: [...s.timelineUndoStack.slice(-49), s.timeline.clips],
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

  undoTimeline: () =>
    set((s) => {
      if (s.timelineUndoStack.length === 0) return s;
      const prev = s.timelineUndoStack[s.timelineUndoStack.length - 1];
      return {
        timelineUndoStack: s.timelineUndoStack.slice(0, -1),
        timelineRedoStack: [...s.timelineRedoStack, s.timeline.clips],
        timeline: { ...s.timeline, clips: prev },
      };
    }),

  redoTimeline: () =>
    set((s) => {
      if (s.timelineRedoStack.length === 0) return s;
      const next = s.timelineRedoStack[s.timelineRedoStack.length - 1];
      return {
        timelineRedoStack: s.timelineRedoStack.slice(0, -1),
        timelineUndoStack: [...s.timelineUndoStack, s.timeline.clips],
        timeline: { ...s.timeline, clips: next },
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
  clearChat: () => set({ messages: [] }),
  setChatModel: (id) => set({ chatModel: id }),

  renameProject: (id, name) =>
    set((s) => ({
      projectName: id === s.activeProjectId ? name : s.projectName,
      projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
    })),

  createProject: () =>
    set((s) => {
      const synced = syncActiveProjectIntoList(s);
      const fresh = newProject(`Untitled Project ${synced.length + 1}`);
      return {
        projects: [...synced, fresh],
        activeProjectId: fresh.id,
        projectName: fresh.name,
        folderHandle: fresh.folderHandle,
        items: fresh.items,
        selectedItemId: null,
        timeline: fresh.timeline,
        settings: fresh.settings,
        messages: fresh.messages,
        chatModel: fresh.chatModel,
        playheadSec: 0,
        isPlaying: false,
        timelineUndoStack: [],
        timelineRedoStack: [],
      };
    }),

  switchProject: (id) =>
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
        items: target.items,
        selectedItemId: null,
        timeline: target.timeline,
        settings: target.settings,
        messages: target.messages,
        chatModel: target.chatModel,
        playheadSec: 0,
        isPlaying: false,
        timelineUndoStack: [],
        timelineRedoStack: [],
      };
    }),

  setTheme: (t) => set({ theme: t }),
  reset: () =>
    set({
      projectName: "Untitled Project",
      folderHandle: null,
      items: [],
      selectedItemId: null,
      timeline: { id: "tl_1", name: "Timeline 1", clips: [] },
      playheadSec: 0,
      isPlaying: false,
      messages: [],
      timelineUndoStack: [],
      timelineRedoStack: [],
    }),
}));
