"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useMonkeStore } from "./store";
import type { ClipMask, ClipRect, Timeline } from "./types";
import { clipDuration, sourceTimeAt, clipSpeed, fadeGainAt } from "./timeline-math";

const DRIFT_CORRECTION_SEC = 0.15;

interface ResolvedClip {
  id: string;
  mediaId: string;
  src: string;
  trimIn: number;
  trimOut: number;
  startOffset: number;
  duration: number;
  position?: ClipRect;
  opacity?: number;
  mask?: ClipMask;
  volume?: number;
  muted?: boolean;
  cutout?: boolean;
  speed?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  videoFadeInSec?: number;
  videoFadeOutSec?: number;
  keyframes?: import("./types").ClipKeyframe[];
  easing?: "linear" | "ease";
}

// Only the base track (trackIndex 0, or unset for clips created before
// layering existed) drives the master sequential clock — overlay tracks
// (trackIndex > 0) float independently at their own timelineStart and are
// composited separately by OverlayLayer, not part of this back-to-back sequence.
function resolveClips(timeline: Timeline, srcForMedia: (mediaId: string) => string): ResolvedClip[] {
  const sorted = timeline.clips
    .filter((c) => (c.trackIndex ?? 0) === 0)
    .sort((a, b) => a.order - b.order);
  let offset = 0;
  const out: ResolvedClip[] = [];
  for (const c of sorted) {
    const duration = clipDuration(c);
    if (duration <= 0) continue;
    out.push({
      id: c.id,
      mediaId: c.mediaId,
      src: srcForMedia(c.mediaId),
      trimIn: c.trimIn,
      trimOut: c.trimOut,
      speed: c.speed,
      startOffset: offset,
      duration,
      position: c.position,
      opacity: c.opacity,
      mask: c.mask,
      volume: c.volume,
      muted: c.muted,
      cutout: c.cutout,
      fadeInSec: c.fadeInSec,
      fadeOutSec: c.fadeOutSec,
      videoFadeInSec: c.videoFadeInSec,
      videoFadeOutSec: c.videoFadeOutSec,
      keyframes: c.keyframes,
      easing: c.easing,
    });
    offset += duration;
  }
  return out;
}

function findClipAt(clips: ResolvedClip[], t: number): { index: number; localTime: number } | null {
  if (clips.length === 0) return null;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const isLast = i === clips.length - 1;
    if (t < c.startOffset + c.duration || (isLast && t <= c.startOffset + c.duration)) {
      return { index: i, localTime: sourceTimeAt(c, t - c.startOffset) };
    }
  }
  const last = clips[clips.length - 1];
  return { index: clips.length - 1, localTime: last.trimOut };
}

// Video elements are owned by the caller (useRef in the component) and
// passed in rather than created/returned here — a hook returning a ref
// object alongside plain state can defeat the React Compiler's purity
// analysis for every other field on the returned object.
export function useTimelinePlayer(videoElA: RefObject<HTMLVideoElement | null>, videoElB: RefObject<HTMLVideoElement | null>) {
  const timeline = useMonkeStore((s) => s.timeline);
  const items = useMonkeStore((s) => s.items);

  const srcForMedia = useCallback(
    (mediaId: string) => items.find((i) => i.id === mediaId)?.objectUrl || "",
    [items]
  );

  const clips = useMemo(() => resolveClips(timeline, srcForMedia), [timeline, srcForMedia]);
  const totalDuration = clips.length > 0 ? clips[clips.length - 1].startOffset + clips[clips.length - 1].duration : 0;

  const getVideoEl = useCallback((slot: 0 | 1): HTMLVideoElement | null => (slot === 0 ? videoElA.current : videoElB.current), [videoElA, videoElB]);

  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeClipIndex, setActiveClipIndex] = useState(0);

  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const currentTimeRef = useRef(0);
  const activeSlotRef = useRef<0 | 1>(0);
  const slotClipIndexRef = useRef<[number, number]>([-1, -1]);
  const activeClipIndexRef = useRef(0);
  // Mirrors `isPlaying` for use inside applyGlobalTime (a useCallback that
  // can't safely close over the React state value across renders the way
  // it needs to when called from the rAF loop) — set alongside every
  // setIsPlaying call, never on its own.
  const isPlayingRef = useRef(false);

  const applyVolume = useCallback(
    (el: HTMLVideoElement, clip: ResolvedClip | undefined) => {
      el.volume = clip?.volume ?? 1;
      el.muted = clip?.muted ?? false;
      // Keep the element's own rate in step, or its audio drifts against
      // the master clock even though we keep re-seeking the video.
      el.playbackRate = clip ? clipSpeed(clip) : 1;
    },
    []
  );

  const loadIntoSlot = useCallback(
    (slot: 0 | 1, clipIndex: number) => {
      const clip = clips[clipIndex];
      const el = getVideoEl(slot);
      if (!clip || !el) return;
      if (el.src !== clip.src) el.src = clip.src;
      applyVolume(el, clip);
      slotClipIndexRef.current = slot === 0 ? [clipIndex, slotClipIndexRef.current[1]] : [slotClipIndexRef.current[0], clipIndex];
    },
    [clips, getVideoEl, applyVolume]
  );

  // This effect both synchronizes an external system (video element refs —
  // loading sources, seeking) and resets the React state that mirrors it,
  // in response to the clip list changing. The lint rule below assumes
  // setState-in-effect is always a "derive during render instead" smell;
  // here the setState calls are inseparable from the ref/DOM sync they
  // accompany, so this is the sanctioned "sync with an external system"
  // case the rule's own docs carve out — scoped disable, not a blanket one.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setIsPlaying(false);
    isPlayingRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    currentTimeRef.current = 0;
    setCurrentTime(0);
    activeClipIndexRef.current = 0;
    setActiveClipIndex(0);
    activeSlotRef.current = 0;
    setActiveSlot(0);
    slotClipIndexRef.current = [-1, -1];
    if (clips.length > 0) {
      loadIntoSlot(0, 0);
      const el = getVideoEl(0);
      if (el) el.currentTime = clips[0].trimIn;
      if (clips.length > 1) loadIntoSlot(1, 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips.map((c) => `${c.id}:${c.src}:${c.trimIn}:${c.trimOut}:${c.volume}:${c.muted}:${c.speed}:${c.fadeInSec}:${c.fadeOutSec}:${c.videoFadeInSec}:${c.videoFadeOutSec}`).join("|")]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const applyGlobalTime = useCallback(
    (t: number, opts?: { seeking?: boolean }) => {
      const resolved = findClipAt(clips, t);
      if (!resolved) return;
      const { index, localTime } = resolved;
      const activeSlotEl = getVideoEl(activeSlotRef.current);

      if (index !== activeClipIndexRef.current) {
        const outgoingEl = activeSlotEl;
        const inactiveSlot: 0 | 1 = activeSlotRef.current === 0 ? 1 : 0;
        let newActiveEl: HTMLVideoElement | null;
        if (slotClipIndexRef.current[inactiveSlot] === index) {
          newActiveEl = getVideoEl(inactiveSlot);
          if (newActiveEl) newActiveEl.currentTime = localTime;
          activeSlotRef.current = inactiveSlot;
          setActiveSlot(inactiveSlot);
        } else {
          loadIntoSlot(activeSlotRef.current, index);
          newActiveEl = activeSlotEl;
          if (newActiveEl) newActiveEl.currentTime = localTime;
        }
        // The previous engine only ever called .play() once, when Play was
        // first pressed — crossing a clip boundary mid-playback swapped
        // which element was "active" (opacity/z-order) but never told the
        // newly-active element to actually play, and never paused the one
        // it replaced. In practice that meant clip 2+ played silently and
        // janked (a paused element repeatedly hard-seeked every ~150ms by
        // the drift correction below) while the outgoing clip kept
        // producing audio in the background. Explicit pause/play here is
        // the fix, not new behavior.
        if (outgoingEl && outgoingEl !== newActiveEl) outgoingEl.pause();
        if (newActiveEl) {
          applyVolume(newActiveEl, clips[index]);
          if (isPlayingRef.current) newActiveEl.play().catch(() => {});
        }
        activeClipIndexRef.current = index;
        setActiveClipIndex(index);
        const nowInactive: 0 | 1 = activeSlotRef.current === 0 ? 1 : 0;
        if (index + 1 < clips.length) loadIntoSlot(nowInactive, index + 1);
      } else if (activeSlotEl) {
        if (opts?.seeking || Math.abs(activeSlotEl.currentTime - localTime) > DRIFT_CORRECTION_SEC) {
          activeSlotEl.currentTime = localTime;
        }
      }

      // Fades are a function of position, so the gain has to be re-applied
      // every tick rather than once when the clip loads.
      const activeClip = clips[activeClipIndexRef.current];
      const el = getVideoEl(activeSlotRef.current);
      if (el && activeClip && ((activeClip.fadeInSec ?? 0) > 0 || (activeClip.fadeOutSec ?? 0) > 0)) {
        el.volume = Math.max(0, Math.min(1, (activeClip.volume ?? 1) * fadeGainAt(activeClip, t - activeClip.startOffset)));
      }

      currentTimeRef.current = t;
      setCurrentTime(t);
    },
    [clips, loadIntoSlot, getVideoEl, applyVolume]
  );

  // Keeps the active element's volume/mute in sync when the CURRENT clip's
  // own volume/muted fields change (e.g. dragging the Inspector's volume
  // slider) without a slot switch — applyGlobalTime only re-applies volume
  // at the moment a switch happens, not on every tick.
  useEffect(() => {
    const el = getVideoEl(activeSlot);
    const clip = clips[activeClipIndex];
    if (el && clip) applyVolume(el, clip);
  }, [clips, activeClipIndex, activeSlot, getVideoEl, applyVolume]);

  // Recursive rAF callbacks need to call themselves, but referencing a
  // `const tick = useCallback(...)` binding from inside its own initializer
  // is flagged as "used before declared" by the compiler's static analysis
  // (closures resolve this fine at runtime, but the linter can't prove it).
  // Route the self-call through a ref instead — assigned after the callback
  // is created, read at call time, never analyzed as a forward reference.
  const tickRef = useRef<(now: number) => void>(() => {});
  const tick = useCallback(
    (now: number) => {
      if (lastTickRef.current == null) lastTickRef.current = now;
      const elapsed = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;

      let next = currentTimeRef.current + elapsed;
      if (next >= totalDuration) {
        next = totalDuration;
        applyGlobalTime(next);
        setIsPlaying(false);
        isPlayingRef.current = false;
        return;
      }
      applyGlobalTime(next);
      rafRef.current = requestAnimationFrame(tickRef.current);
    },
    [applyGlobalTime, totalDuration]
  );
  // Ref writes must happen in an effect, not during render.
  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  const play = useCallback(() => {
    if (clips.length === 0) return;
    if (currentTimeRef.current >= totalDuration) {
      currentTimeRef.current = 0;
      applyGlobalTime(0, { seeking: true });
    }
    setIsPlaying(true);
    isPlayingRef.current = true;
    lastTickRef.current = null;
    getVideoEl(activeSlotRef.current)?.play().catch(() => {});
    rafRef.current = requestAnimationFrame(tick);
  }, [applyGlobalTime, clips.length, tick, totalDuration, getVideoEl]);

  const pause = useCallback(() => {
    setIsPlaying(false);
    isPlayingRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    getVideoEl(activeSlotRef.current)?.pause();
  }, [getVideoEl]);

  const seek = useCallback(
    (sec: number) => {
      const clamped = Math.max(0, Math.min(totalDuration, sec));
      applyGlobalTime(clamped, { seeking: true });
    },
    [applyGlobalTime, totalDuration]
  );

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  return { activeSlot, play, pause, seek, currentTime, isPlaying, activeClipIndex, activeClipId: clips[activeClipIndex]?.id ?? null, totalDuration, clips };
}
