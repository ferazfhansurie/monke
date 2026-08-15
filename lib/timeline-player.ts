"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useMonkeStore } from "./store";
import type { Timeline } from "./types";

const DRIFT_CORRECTION_SEC = 0.15;

interface ResolvedClip {
  id: string;
  mediaId: string;
  src: string;
  trimIn: number;
  trimOut: number;
  startOffset: number;
  duration: number;
}

function resolveClips(timeline: Timeline, srcForMedia: (mediaId: string) => string): ResolvedClip[] {
  const sorted = [...timeline.clips].sort((a, b) => a.order - b.order);
  let offset = 0;
  const out: ResolvedClip[] = [];
  for (const c of sorted) {
    const duration = Math.max(0, c.trimOut - c.trimIn);
    if (duration <= 0) continue;
    out.push({ id: c.id, mediaId: c.mediaId, src: srcForMedia(c.mediaId), trimIn: c.trimIn, trimOut: c.trimOut, startOffset: offset, duration });
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
      return { index: i, localTime: c.trimIn + Math.max(0, t - c.startOffset) };
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

  const loadIntoSlot = useCallback(
    (slot: 0 | 1, clipIndex: number) => {
      const clip = clips[clipIndex];
      const el = getVideoEl(slot);
      if (!clip || !el) return;
      if (el.src !== clip.src) el.src = clip.src;
      slotClipIndexRef.current = slot === 0 ? [clipIndex, slotClipIndexRef.current[1]] : [slotClipIndexRef.current[0], clipIndex];
    },
    [clips, getVideoEl]
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
  }, [clips.map((c) => `${c.id}:${c.src}:${c.trimIn}:${c.trimOut}`).join("|")]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const applyGlobalTime = useCallback(
    (t: number, opts?: { seeking?: boolean }) => {
      const resolved = findClipAt(clips, t);
      if (!resolved) return;
      const { index, localTime } = resolved;
      const activeSlotEl = getVideoEl(activeSlotRef.current);

      if (index !== activeClipIndexRef.current) {
        const inactiveSlot: 0 | 1 = activeSlotRef.current === 0 ? 1 : 0;
        if (slotClipIndexRef.current[inactiveSlot] === index) {
          const inactiveEl = getVideoEl(inactiveSlot);
          if (inactiveEl) inactiveEl.currentTime = localTime;
          activeSlotRef.current = inactiveSlot;
          setActiveSlot(inactiveSlot);
        } else {
          loadIntoSlot(activeSlotRef.current, index);
          if (activeSlotEl) activeSlotEl.currentTime = localTime;
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

      currentTimeRef.current = t;
      setCurrentTime(t);
    },
    [clips, loadIntoSlot, getVideoEl]
  );

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
    lastTickRef.current = null;
    getVideoEl(activeSlotRef.current)?.play().catch(() => {});
    rafRef.current = requestAnimationFrame(tick);
  }, [applyGlobalTime, clips.length, tick, totalDuration, getVideoEl]);

  const pause = useCallback(() => {
    setIsPlaying(false);
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
