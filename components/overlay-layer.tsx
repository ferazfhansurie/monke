"use client";

import { useEffect, useMemo, useRef } from "react";
import { useMonkeStore } from "@/lib/store";
import { clipLayerStyle } from "@/lib/layer-style";
import type { TimelineClip } from "@/lib/types";

const DRIFT_CORRECTION_SEC = 0.15;

interface OverlayLayerProps {
  masterTime: number;
  isPlaying: boolean;
}

// Composites overlay-track clips (trackIndex > 0) on top of the base
// track's video elements. Each active overlay gets its own <video>,
// mounted only while the master clock is inside its [timelineStart,
// timelineStart + duration) window — simpler than the base track's
// dual-buffer technique (no gapless-seam requirement for a PiP/watermark
// layer), at the cost of a brief load/seek pop the first time a given
// overlay clip becomes active. Muted: the base track carries the audio.
export function OverlayLayer({ masterTime, isPlaying }: OverlayLayerProps) {
  const timeline = useMonkeStore((s) => s.timeline);
  const items = useMonkeStore((s) => s.items);

  const activeOverlays = useMemo(() => {
    return timeline.clips
      .filter((c) => (c.trackIndex ?? 0) > 0)
      .filter((c) => {
        const start = c.timelineStart ?? 0;
        const duration = Math.max(0, c.trimOut - c.trimIn);
        return masterTime >= start && masterTime < start + duration;
      })
      .sort((a, b) => (a.trackIndex ?? 0) - (b.trackIndex ?? 0));
  }, [timeline.clips, masterTime]);

  return (
    <>
      {activeOverlays.map((clip) => {
        const item = items.find((i) => i.id === clip.mediaId);
        if (!item?.objectUrl) return null;
        return <OverlayClipVideo key={clip.id} clip={clip} src={item.objectUrl} masterTime={masterTime} isPlaying={isPlaying} />;
      })}
    </>
  );
}

function OverlayClipVideo({ clip, src, masterTime, isPlaying }: { clip: TimelineClip; src: string; masterTime: number; isPlaying: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const localTime = clip.trimIn + Math.max(0, masterTime - (clip.timelineStart ?? 0));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (Math.abs(el.currentTime - localTime) > DRIFT_CORRECTION_SEC) el.currentTime = localTime;
  }, [localTime]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !isPlaying) return;
    el.play().catch(() => {});
    return () => el.pause();
  }, [isPlaying]);

  return <video ref={ref} src={src} muted playsInline style={clipLayerStyle(clip)} />;
}
