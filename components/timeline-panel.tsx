"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Scissors, Trash2, Undo, Redo, ZoomIn, ZoomOut, Type, Captions, Loader2 } from "lucide-react";
import { useMonkeStore } from "@/lib/store";
import { transcribeAudio } from "@/lib/audio";
import { ClipWaveform } from "./clip-waveform";
import { clipDuration, clipSpeed } from "@/lib/timeline-math";
import type { useTimelinePlayer } from "@/lib/timeline-player";

type DragKind = "start" | "end" | "reorder" | "scrub" | "move" | null;

const BASE_PX_PER_SEC = 40;
const SNAP_THRESHOLD_PX = 8;

// Snaps a candidate timeline-space position (seconds) to the nearest of a
// set of target positions if it's within SNAP_THRESHOLD_PX on screen —
// otherwise returns the candidate unchanged. Threshold is in pixels (not
// seconds) so it feels the same regardless of zoom level.
function snapToNearby(sec: number, targets: number[], pxPerSec: number): number {
  const thresholdSec = SNAP_THRESHOLD_PX / pxPerSec;
  let best = sec;
  let bestDist = thresholdSec;
  for (const t of targets) {
    const dist = Math.abs(sec - t);
    if (dist < bestDist) {
      best = t;
      bestDist = dist;
    }
  }
  return best;
}

function fmtRulerTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Picks a "nice" tick spacing (seconds) so marks land roughly 60px apart on
// screen regardless of zoom, instead of a fixed interval that's either a
// dense unreadable comb when zoomed out or needlessly sparse zoomed in.
function pickTickInterval(pxPerSec: number): number {
  const target = 60;
  for (const candidate of [1, 2, 5, 10, 15, 30, 60, 120, 300]) {
    if (candidate * pxPerSec >= target) return candidate;
  }
  return 600;
}

// A click or drag anywhere on this strip seeks the playhead there — it's a
// plain, non-propagation-stopping child of the track container, so the
// click bubbles up to the container's own onPointerDown (beginScrub) the
// same way empty track background does. Purely visual otherwise.
function TimeRuler({ pxPerSec, totalDuration }: { pxPerSec: number; totalDuration: number }) {
  const interval = pickTickInterval(pxPerSec);
  const tickCount = Math.max(1, Math.ceil((totalDuration + interval) / interval));
  const ticks = Array.from({ length: tickCount }, (_, i) => i * interval);
  return (
    <div className="relative h-5 cursor-pointer border-b border-white/10">
      {ticks.map((t) => (
        <div key={t} className="absolute top-0 bottom-0 border-l border-white/15" style={{ left: t * pxPerSec }}>
          <span className="absolute left-1 top-0 text-[9px] text-gray-500">{fmtRulerTime(t)}</span>
        </div>
      ))}
    </div>
  );
}

interface TimelinePanelProps {
  player: ReturnType<typeof useTimelinePlayer>;
}

export function TimelinePanel({ player }: TimelinePanelProps) {
  const timeline = useMonkeStore((s) => s.timeline);
  const items = useMonkeStore((s) => s.items);
  const updateTimelineClip = useMonkeStore((s) => s.updateTimelineClip);
  const removeTimelineClip = useMonkeStore((s) => s.removeTimelineClip);
  const reorderTimelineClip = useMonkeStore((s) => s.reorderTimelineClip);
  const splitTimelineClip = useMonkeStore((s) => s.splitTimelineClip);
  const addTimelineClip = useMonkeStore((s) => s.addTimelineClip);
  const frameRate = useMonkeStore((s) => s.settings.frameRate);
  const timelineUndoStack = useMonkeStore((s) => s.timelineUndoStack);
  const timelineRedoStack = useMonkeStore((s) => s.timelineRedoStack);
  const undoTimeline = useMonkeStore((s) => s.undoTimeline);
  const redoTimeline = useMonkeStore((s) => s.redoTimeline);
  const selectedClipId = useMonkeStore((s) => s.selectedClipId);
  const setSelectedClipId = useMonkeStore((s) => s.selectClip);
  const selectedCaptionId = useMonkeStore((s) => s.selectedCaptionId);
  const setSelectedCaptionId = useMonkeStore((s) => s.selectCaption);
  const addCaption = useMonkeStore((s) => s.addCaption);
  const removeCaption = useMonkeStore((s) => s.removeCaption);

  const [dragging, setDragging] = useState<DragKind>(null);
  const [autoCaptioning, setAutoCaptioning] = useState(false);
  const [zoom, setZoom] = useState(1);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragClipIdRef = useRef<string | null>(null);
  const grabOffsetSecRef = useRef(0);
  const pxPerSec = BASE_PX_PER_SEC * zoom;

  const onPointerDownClip = (clipId: string) => (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.dataset.handle) return;
    e.stopPropagation();
    setSelectedClipId(clipId);
    setSelectedCaptionId(null);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragClipIdRef.current = clipId;
    setDragging("reorder");
  };

  // Overlay clips float at an explicit timelineStart rather than being
  // sequenced, so moving one is just changing that start — no reordering.
  const beginOverlayMove = (clipId: string, timelineStart: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.dataset.handle) return; // let the trim handles win
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setSelectedClipId(clipId);
    setSelectedCaptionId(null);
    const rect = trackRef.current?.getBoundingClientRect();
    grabOffsetSecRef.current = rect ? Math.max(0, (e.clientX - rect.left) / pxPerSec) - timelineStart : 0;
    dragClipIdRef.current = clipId;
    setDragging("move");
  };

  const beginTrimDrag = (clipId: string, kind: "start" | "end") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setSelectedClipId(clipId);
    setSelectedCaptionId(null);
    dragClipIdRef.current = clipId;
    setDragging(kind);
  };

  // Master-clock positions of every OTHER clip's edges, for snapping.
  const edgeSnapTargets = useCallback(
    (excludeClipId: string): number[] => {
      const targets: number[] = [];
      let offset = 0;
      for (const c of timeline.clips.filter((c) => (c.trackIndex ?? 0) === 0).sort((a, b) => a.order - b.order)) {
        const dur = clipDuration(c);
        if (c.id !== excludeClipId) targets.push(offset, offset + dur);
        offset += dur;
      }
      for (const c of timeline.clips.filter((c) => (c.trackIndex ?? 0) > 0)) {
        if (c.id === excludeClipId) continue;
        const start = c.timelineStart ?? 0;
        targets.push(start, start + clipDuration(c));
      }
      return targets;
    },
    [timeline.clips]
  );

  const xToSeconds = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return 0;
      return Math.max(0, Math.min(player.totalDuration, (clientX - rect.left) / pxPerSec));
    },
    [pxPerSec, player.totalDuration]
  );

  // Click (or drag) anywhere on the ruler, or empty track background not
  // occupied by a clip/caption/overlay box, moves the playhead there —
  // clips/captions/overlays call stopPropagation on their own pointerdown,
  // so this only fires for genuinely empty space, never stealing a
  // select/reorder/trim gesture.
  const beginScrub = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      dragClipIdRef.current = null;
      setDragging("scrub");
      player.seek(xToSeconds(e.clientX));
    },
    [player, xToSeconds]
  );

  const xToOrder = useCallback(
    (clientX: number, draggedClipId: string): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return 0;
      const sec = Math.max(0, (clientX - rect.left) / pxPerSec);
      const others = timeline.clips.filter((c) => c.id !== draggedClipId && (c.trackIndex ?? 0) === 0).sort((a, b) => a.order - b.order);
      if (others.length === 0) return 0;
      let acc = 0;
      for (let i = 0; i < others.length; i++) {
        const dur = Math.max(0, others[i].trimOut - others[i].trimIn);
        if (sec < acc + dur / 2) {
          const prevOrder = i > 0 ? others[i - 1].order : others[i].order - 1;
          return (prevOrder + others[i].order) / 2;
        }
        acc += dur;
      }
      return others[others.length - 1].order + 1;
    },
    [timeline, pxPerSec]
  );

  const onTrackPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      if (dragging === "scrub") {
        player.seek(xToSeconds(e.clientX));
        return;
      }
      if (!dragClipIdRef.current) return;
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sec = Math.max(0, (e.clientX - rect.left) / pxPerSec);
      const clip = timeline.clips.find((c) => c.id === dragClipIdRef.current);
      if (!clip) return;

      const isOverlay = (clip.trackIndex ?? 0) > 0;

      if (isOverlay) {
        // Overlays are positioned absolutely on the master clock, so their
        // math is simpler than the base track's: no summing of preceding
        // clips, just this clip's own timelineStart.
        const start = clip.timelineStart ?? 0;
        const item = items.find((i) => i.id === clip.mediaId);
        const sourceDur = item?.durationSec ?? clip.trimOut;
        const snapped = snapToNearby(sec, [0, player.currentTime, ...edgeSnapTargets(clip.id)], pxPerSec);

        if (dragging === "move") {
          updateTimelineClip(clip.id, { timelineStart: Math.max(0, snapToNearby(sec - grabOffsetSecRef.current, [0, player.currentTime, ...edgeSnapTargets(clip.id)], pxPerSec)) });
        } else if (dragging === "start") {
          // Trimming the head moves the in-point AND the start together, so
          // the frames already on screen stay put instead of sliding.
          const delta = snapped - start;
          const trimIn = Math.max(0, Math.min(clip.trimIn + delta, clip.trimOut - 0.1));
          updateTimelineClip(clip.id, { trimIn, timelineStart: Math.max(0, start + (trimIn - clip.trimIn)) });
        } else if (dragging === "end") {
          const trimOut = Math.min(sourceDur, Math.max(snapped - start + clip.trimIn, clip.trimIn + 0.1));
          updateTimelineClip(clip.id, { trimOut });
        }
        return;
      }

      if (dragging === "start" || dragging === "end") {
        // Trim handles are dragged in TIMELINE space (screen position), but
        // trimIn/trimOut are offsets into the SOURCE media — only equal to
        // the raw cursor position for a clip sitting at timeline position 0.
        // For any later clip this must go through the clip's own
        // startOffset (sum of every base-track clip before it), or trimming
        // clip 2+ silently computed a nonsense value clamped against its own
        // bounds. Snapping targets: 0, the playhead, and this clip's own
        // untouched other edge (so dragging one handle can't cross the other).
        const baseSorted = timeline.clips.filter((c) => (c.trackIndex ?? 0) === 0).sort((a, b) => a.order - b.order);
        let startOffset = 0;
        for (const c of baseSorted) {
          if (c.id === clip.id) break;
          startOffset += clipDuration(c);
        }
        const duration = clipDuration(clip);
        // Snapping to other clips' edges is what makes butt-joins land
        // exactly instead of leaving a sub-frame sliver.
        const snapTargets = [0, player.currentTime, ...edgeSnapTargets(clip.id)];

        if (dragging === "start") {
          const snappedTimelinePos = snapToNearby(sec, snapTargets, pxPerSec);
          const trimIn = clip.trimIn + (snappedTimelinePos - startOffset);
          updateTimelineClip(clip.id, { trimIn: Math.max(0, Math.min(trimIn, clip.trimOut - 0.1)) });
        } else {
          const item = items.find((i) => i.id === clip.mediaId);
          const cap = item?.durationSec ?? clip.trimOut + 999;
          const snappedTimelinePos = snapToNearby(sec, snapTargets, pxPerSec);
          const trimOut = clip.trimOut + (snappedTimelinePos - (startOffset + duration));
          updateTimelineClip(clip.id, { trimOut: Math.min(cap, Math.max(trimOut, clip.trimIn + 0.1)) });
        }
      } else if (dragging === "reorder") {
        reorderTimelineClip(clip.id, xToOrder(e.clientX, clip.id));
      }
    },
    [dragging, timeline, items, updateTimelineClip, reorderTimelineClip, xToOrder, pxPerSec, player, xToSeconds, edgeSnapTargets]
  );

  const onDropMedia = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const mediaId = e.dataTransfer.getData("application/monke-media-id");
      if (mediaId) addTimelineClip(mediaId, {});
    },
    [addTimelineClip]
  );

  const endDrag = useCallback(() => {
    setDragging(null);
    dragClipIdRef.current = null;
  }, []);

  const clips = timeline.clips.filter((c) => (c.trackIndex ?? 0) === 0).sort((a, b) => a.order - b.order);
  const overlayClips = timeline.clips.filter((c) => (c.trackIndex ?? 0) > 0).sort((a, b) => (a.trackIndex ?? 0) - (b.trackIndex ?? 0));

  const splitAtPlayhead = useCallback(() => {
    if (!selectedClipId) return;
    const clip = timeline.clips.find((c) => c.id === selectedClipId);
    if (!clip || (clip.trackIndex ?? 0) !== 0) return; // splitting overlay clips isn't supported yet — base track only
    const startOffset = player.clips.find((c) => c.id === selectedClipId)?.startOffset ?? 0;
    // splitTimelineClip takes an offset into the SOURCE, so convert from
    // timeline seconds through the clip's speed.
    const local = Math.max(0.05, (player.currentTime - startOffset) * clipSpeed(clip));
    const dur = Math.max(0, clip.trimOut - clip.trimIn);
    const newId = splitTimelineClip(selectedClipId, Math.min(dur - 0.05, local));
    if (newId) setSelectedClipId(newId);
  }, [selectedClipId, timeline.clips, player.clips, player.currentTime, splitTimelineClip, setSelectedClipId]);

  const deleteSelected = useCallback(() => {
    if (selectedCaptionId) {
      removeCaption(selectedCaptionId);
      setSelectedCaptionId(null);
      return;
    }
    if (!selectedClipId) return;
    removeTimelineClip(selectedClipId);
    setSelectedClipId(null);
  }, [selectedClipId, selectedCaptionId, removeTimelineClip, removeCaption, setSelectedClipId, setSelectedCaptionId]);

  const addCaptionAtPlayhead = useCallback(() => {
    const start = player.currentTime;
    const end = Math.min(player.totalDuration || start + 2, start + 2);
    const id = addCaption({
      text: "New caption",
      start,
      end: end > start ? end : start + 2,
      fontFamily: "Inter",
      fontSize: 64,
      color: "#ffffff",
      position: { x: 0.05, y: 0.78, width: 0.9, height: 0.15 },
      bold: true,
    });
    setSelectedCaptionId(id);
    setSelectedClipId(null);
  }, [player.currentTime, player.totalDuration, addCaption, setSelectedCaptionId, setSelectedClipId]);

  // One-click auto-captions: transcribes every base-track clip (in its own
  // trimmed range) and drops a caption line per speech segment, positioned
  // on the master timeline using the same startOffset math the player uses
  // to place clips back-to-back. A manual, no-chat-required path to the
  // same thing the agent can do via add_captions.
  const runAutoCaptions = useCallback(async () => {
    if (clips.length === 0 || autoCaptioning) return;
    setAutoCaptioning(true);
    try {
      for (const resolved of player.clips) {
        const clip = clips.find((c) => c.id === resolved.id);
        if (!clip) continue;
        const item = items.find((i) => i.id === clip.mediaId);
        if (!item || item.kind !== "video") continue;
        const result = await transcribeAudio(item, clip.trimIn, clip.trimOut);
        for (const chunk of result.chunks) {
          if (!chunk.text.trim()) continue;
          const localStart = Math.max(0, chunk.start - clip.trimIn);
          const localEnd = Math.max(localStart + 0.3, chunk.end - clip.trimIn);
          addCaption({
            text: chunk.text.trim(),
            start: resolved.startOffset + localStart,
            end: resolved.startOffset + localEnd,
            fontFamily: "Inter",
            fontSize: 64,
            color: "#ffffff",
            position: { x: 0.05, y: 0.78, width: 0.9, height: 0.15 },
            bold: true,
          });
        }
      }
    } finally {
      setAutoCaptioning(false);
    }
  }, [clips, player.clips, items, autoCaptioning, addCaption]);

  // Standard NLE shortcuts. Ignored while typing in any input/textarea
  // (chat box included) so "s" for split doesn't eat a keystroke there.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isTyping) return;

      if (e.code === "Space") {
        e.preventDefault();
        if (player.isPlaying) player.pause();
        else player.play();
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        splitAtPlayhead();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        player.seek(player.currentTime - 1 / frameRate);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        player.seek(player.currentTime + 1 / frameRate);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redoTimeline();
        else undoTimeline();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [player, splitAtPlayhead, deleteSelected, frameRate, undoTimeline, redoTimeline]);

  return (
    <div className="flex h-full flex-col bg-[#0a0c10]">
      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5">
        <button
          type="button"
          onClick={undoTimeline}
          disabled={timelineUndoStack.length === 0}
          className="rounded p-1.5 text-gray-500 hover:bg-white/10 hover:text-gray-300 disabled:opacity-30 disabled:hover:bg-transparent"
          title="Undo"
        >
          <Undo className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={redoTimeline}
          disabled={timelineRedoStack.length === 0}
          className="rounded p-1.5 text-gray-500 hover:bg-white/10 hover:text-gray-300 disabled:opacity-30 disabled:hover:bg-transparent"
          title="Redo"
        >
          <Redo className="h-3.5 w-3.5" />
        </button>
        <div className="mx-1 h-4 w-px bg-white/10" />
        <button
          type="button"
          onClick={splitAtPlayhead}
          disabled={!selectedClipId}
          className="rounded p-1.5 text-gray-500 hover:bg-white/10 hover:text-gray-300 disabled:opacity-30 disabled:hover:bg-transparent"
          title="Split selected clip at playhead (S)"
        >
          <Scissors className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={deleteSelected}
          disabled={!selectedClipId && !selectedCaptionId}
          className="rounded p-1.5 text-gray-500 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-500"
          title="Delete selected clip/caption (Delete)"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <div className="mx-1 h-4 w-px bg-white/10" />
        <button type="button" onClick={addCaptionAtPlayhead} className="rounded p-1.5 text-gray-500 hover:bg-white/10 hover:text-gray-300" title="Add caption at playhead">
          <Type className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={runAutoCaptions}
          disabled={clips.length === 0 || autoCaptioning}
          className="flex items-center gap-1 rounded p-1.5 text-gray-500 hover:bg-white/10 hover:text-gray-300 disabled:opacity-30 disabled:hover:bg-transparent"
          title="Auto-generate captions from speech in the base track"
        >
          {autoCaptioning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Captions className="h-3.5 w-3.5" />}
        </button>
        <div className="flex-1" />
        <button type="button" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))} className="rounded p-1.5 text-gray-500 hover:bg-white/10 hover:text-gray-300">
          <ZoomOut className="h-3.5 w-3.5" />
        </button>
        <input
          type="range"
          min={0.25}
          max={3}
          step={0.25}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          title="Zoom"
          className="w-20 opacity-40 transition-opacity hover:opacity-100 focus:opacity-100 accent-[#f26522]"
        />
        <button type="button" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} className="rounded p-1.5 text-gray-500 hover:bg-white/10 hover:text-gray-300">
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center border-b border-white/10 px-2 py-1 text-[10px] font-semibold text-gray-400">Timeline 1</div>

      <div
        ref={trackRef}
        onPointerDown={beginScrub}
        onPointerMove={onTrackPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDrop={onDropMedia}
        onDragOver={(e) => e.preventDefault()}
        className="relative flex-1 overflow-x-auto overflow-y-hidden px-2 py-2 select-none"
        style={{ touchAction: "none" }}
      >
        <div className="relative flex flex-col gap-1" style={{ width: Math.max(600, player.totalDuration * pxPerSec + 100) }}>
          <TimeRuler pxPerSec={pxPerSec} totalDuration={player.totalDuration} />
          {timeline.captions.length > 0 && (
            <div className="relative h-8 border-b border-white/5 pb-1">
              {timeline.captions.map((caption) => {
                const left = caption.start * pxPerSec;
                const width = Math.max(20, (caption.end - caption.start) * pxPerSec);
                const isSelected = selectedCaptionId === caption.id;
                return (
                  <div
                    key={caption.id}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelectedCaptionId(caption.id);
                      setSelectedClipId(null);
                    }}
                    className={`absolute top-0 bottom-0 overflow-hidden rounded-md border-2 bg-[#1a2a1f] cursor-pointer ${
                      isSelected ? "border-[#f26522]" : "border-white/15 hover:border-white/30"
                    }`}
                    style={{ left, width }}
                    title={caption.text}
                  >
                    <div className="truncate px-1.5 py-1 text-[9px] text-white/90">{caption.text}</div>
                  </div>
                );
              })}
            </div>
          )}

          {overlayClips.length > 0 && (
            <div className="relative h-10 border-b border-white/5 pb-1">
              {overlayClips.map((clip) => {
                const duration = clipDuration(clip);
                const left = (clip.timelineStart ?? 0) * pxPerSec;
                const width = Math.max(20, duration * pxPerSec);
                const item = items.find((i) => i.id === clip.mediaId);
                const isSelected = selectedClipId === clip.id;
                return (
                  <div
                    key={clip.id}
                    onPointerDown={beginOverlayMove(clip.id, clip.timelineStart ?? 0)}
                    className={`absolute top-0 bottom-0 overflow-hidden rounded-md border-2 bg-[#2a1f14] cursor-grab active:cursor-grabbing ${
                      isSelected ? "border-[#f26522]" : "border-white/15 hover:border-white/30"
                    }`}
                    style={{ left, width }}
                    title={`${item?.name ?? "overlay"} — track ${clip.trackIndex} · drag to move, edges to trim`}
                  >
                    <div className="truncate px-1.5 py-1 text-[9px] text-white/90">{item?.name || "overlay"}</div>
                    <div data-handle="start" onPointerDown={beginTrimDrag(clip.id, "start")} className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize bg-[#f26522]/60 hover:bg-[#f26522]" />
                    <div data-handle="end" onPointerDown={beginTrimDrag(clip.id, "end")} className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize bg-[#f26522]/60 hover:bg-[#f26522]" />
                  </div>
                );
              })}
            </div>
          )}

          <div className="relative h-16">
            {clips.length === 0 && (
              <div className="flex h-full items-center justify-center rounded-md border border-dashed border-white/10 text-[11px] text-gray-600">
                Double-click a clip in the library, or drag it here
              </div>
            )}
            {clips
              .reduce<{ clip: (typeof clips)[number]; duration: number; startOffset: number }[]>((acc, clip) => {
                const duration = clipDuration(clip);
                const prevEnd = acc.length > 0 ? acc[acc.length - 1].startOffset + acc[acc.length - 1].duration : 0;
                return [...acc, { clip, duration, startOffset: prevEnd }];
              }, [])
              .map(({ clip, duration, startOffset }) => {
                const left = startOffset * pxPerSec;
                const width = Math.max(24, duration * pxPerSec);
                const item = items.find((i) => i.id === clip.mediaId);
                const isSelected = selectedClipId === clip.id;
                return (
                  <div
                    key={clip.id}
                    onPointerDown={onPointerDownClip(clip.id)}
                    className={`absolute top-0 bottom-0 overflow-hidden rounded-md border-2 bg-[#1c2128] cursor-grab active:cursor-grabbing ${
                      isSelected ? "border-[#f26522]" : "border-white/15 hover:border-white/30"
                    }`}
                    style={{ left, width }}
                    title={item?.name}
                  >
                    {item?.thumbnailUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.thumbnailUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />
                    )}
                    {item && (item.kind === "video" || item.kind === "audio") && (
                      <ClipWaveform item={item} trimIn={clip.trimIn} trimOut={clip.trimOut} width={width} height={22} />
                    )}
                    <div className="relative flex items-center gap-1 px-1.5 py-1 text-[9px] text-white/90">
                      <span className="truncate">{item?.name || "clip"}</span>
                      {clipSpeed(clip) !== 1 && (
                        <span className="shrink-0 rounded bg-[#f26522]/20 px-1 font-mono text-[8px] text-[#f26522]">{clipSpeed(clip)}×</span>
                      )}
                    </div>
                    <div data-handle="start" onPointerDown={beginTrimDrag(clip.id, "start")} className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize bg-[#f26522]/60 hover:bg-[#f26522]" />
                    <div data-handle="end" onPointerDown={beginTrimDrag(clip.id, "end")} className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize bg-[#f26522]/60 hover:bg-[#f26522]" />
                  </div>
                );
              })}
          </div>

          {(clips.length > 0 || overlayClips.length > 0 || timeline.captions.length > 0) && (
            <div
              className="pointer-events-none absolute top-0 bottom-0 w-[2px] bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]"
              style={{ left: player.currentTime * pxPerSec }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
