"use client";

import { useRef, type RefObject } from "react";
import { Play, Pause, SkipBack, SkipForward, StepBack, StepForward, Maximize2 } from "lucide-react";
import { useMonkeStore } from "@/lib/store";
import type { useTimelinePlayer } from "@/lib/timeline-player";

function fmtTimecode(sec: number, fps: number) {
  const total = Math.max(0, sec);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total - Math.floor(total)) * fps);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}:${f.toString().padStart(2, "0")}`;
}

interface PreviewPlayerProps {
  player: ReturnType<typeof useTimelinePlayer>;
  videoElA: RefObject<HTMLVideoElement | null>;
  videoElB: RefObject<HTMLVideoElement | null>;
}

// The player engine (video refs + useTimelinePlayer) is owned by the parent
// EditorStage and passed in here — PreviewPlayer and TimelinePanel must
// drive the SAME playback engine, not two independent ones.
export function PreviewPlayer({ player, videoElA, videoElB }: PreviewPlayerProps) {
  const settings = useMonkeStore((s) => s.settings);
  const stageRef = useRef<HTMLDivElement>(null);

  const aspect = settings.resolutionW / settings.resolutionH;

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      stageRef.current?.requestFullscreen().catch(() => {});
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#050607]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="text-[11px] font-semibold text-gray-300">Timeline 1</span>
        <button type="button" onClick={toggleFullscreen} className="rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-300" title="Fullscreen preview">
          <Maximize2 className="h-3 w-3" />
        </button>
      </div>

      <div ref={stageRef} className="relative flex flex-1 items-center justify-center overflow-hidden bg-black p-4">
        <div className="relative h-full max-h-full" style={{ aspectRatio: aspect }}>
          <video ref={videoElA} className={`absolute inset-0 h-full w-full object-contain ${player.activeSlot === 0 ? "opacity-100" : "opacity-0"}`} playsInline />
          <video ref={videoElB} className={`absolute inset-0 h-full w-full object-contain ${player.activeSlot === 1 ? "opacity-100" : "opacity-0"}`} playsInline />
          {player.clips.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center border border-dashed border-white/10 text-[11px] text-gray-600">
              Nothing on the timeline
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-center gap-1 border-t border-white/10 px-3 py-1.5 font-mono text-[10px] text-gray-500">
        <span>{fmtTimecode(player.currentTime, settings.frameRate)}</span>
      </div>

      <div className="flex items-center justify-center gap-3 border-t border-white/10 py-2">
        <button type="button" onClick={() => player.seek(0)} className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white">
          <SkipBack className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => player.seek(player.currentTime - 1 / settings.frameRate)} className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white">
          <StepBack className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => (player.isPlaying ? player.pause() : player.play())}
          disabled={player.clips.length === 0}
          className="rounded-full bg-white/10 p-2 hover:bg-white/20 disabled:opacity-30 transition-colors"
        >
          {player.isPlaying ? <Pause className="h-4 w-4 text-white" /> : <Play className="h-4 w-4 text-white" fill="currentColor" />}
        </button>
        <button type="button" onClick={() => player.seek(player.currentTime + 1 / settings.frameRate)} className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white">
          <StepForward className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => player.seek(player.totalDuration)} className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white">
          <SkipForward className="h-3.5 w-3.5" />
        </button>
        <span className="ml-3 font-mono text-[10px] text-gray-600">1x</span>
      </div>
    </div>
  );
}
