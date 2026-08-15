"use client";

import { create } from "zustand";
import type { MediaItem, Timeline, TimelineClip, ProjectSettings, ChatMessage } from "./types";

interface MonkeState {
  // Project / folder
  projectName: string;
  folderHandle: FileSystemDirectoryHandle | null;
  isLoadingFolder: boolean;
  loadProgress: { done: number; total: number } | null;

  // Media library
  items: MediaItem[];
  selectedItemId: string | null;

  // Timeline (single track for v1)
  timeline: Timeline;
  playheadSec: number;
  isPlaying: boolean;

  // Project settings
  settings: ProjectSettings;

  // Chat
  messages: ChatMessage[];

  // Panels
  theme: "light" | "dark";

  // Actions
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
  setPlayhead: (sec: number) => void;
  setIsPlaying: (v: boolean) => void;
  setSettings: (patch: Partial<ProjectSettings>) => void;
  // id/createdAt are generated here, not by the caller — Date.now()/random
  // IDs constructed inside a component body during render are flagged as
  // impure by the React Compiler; store actions run outside render, so
  // it's the right place for this.
  sendMessage: (role: ChatMessage["role"], text: string) => void;
  setTheme: (t: "light" | "dark") => void;
  reset: () => void;
}

const defaultSettings: ProjectSettings = {
  resolutionW: 1080,
  resolutionH: 1920,
  frameRate: 30,
  aspectRatio: "9:16",
};

export const useMonkeStore = create<MonkeState>((set, get) => ({
  projectName: "Untitled Project",
  folderHandle: null,
  isLoadingFolder: false,
  loadProgress: null,
  items: [],
  selectedItemId: null,
  timeline: { id: "tl_1", name: "Timeline 1", clips: [] },
  playheadSec: 0,
  isPlaying: false,
  settings: defaultSettings,
  messages: [],
  theme: "dark",

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
      return { timeline: { ...s.timeline, clips: [...clips, newClip] } };
    });
    return clipId;
  },

  updateTimelineClip: (clipId, patch) =>
    set((s) => ({
      timeline: { ...s.timeline, clips: s.timeline.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) },
    })),

  removeTimelineClip: (clipId) =>
    set((s) => ({ timeline: { ...s.timeline, clips: s.timeline.clips.filter((c) => c.id !== clipId) } })),

  reorderTimelineClip: (clipId, order) =>
    set((s) => ({
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
        timeline: { ...s.timeline, clips: s.timeline.clips.map((c) => (c.id === clipId ? first : c)).concat(second) },
      };
    });
    return newClipId;
  },

  setPlayhead: (sec) => set({ playheadSec: sec }),
  setIsPlaying: (v) => set({ isPlaying: v }),
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  sendMessage: (role, text) =>
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          role,
          parts: [{ type: "text", text }],
          createdAt: new Date().toISOString(),
        },
      ],
    })),
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
    }),
}));
