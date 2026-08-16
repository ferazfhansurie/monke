"use client";

import { useRef } from "react";
import { TopBar } from "./top-bar";
import { ChatPanel } from "./chat-panel";
import { MediaLibrary } from "./media-library";
import { PreviewPlayer } from "./preview-player";
import { InspectorPanel } from "./inspector-panel";
import { TimelinePanel } from "./timeline-panel";
import { GenerationPoller } from "./generation-poller";
import { useTimelinePlayer } from "@/lib/timeline-player";

// Owns the single shared playback engine (video element refs +
// useTimelinePlayer) and hands it to both PreviewPlayer (which renders the
// visible <video> tags) and TimelinePanel (which reads/drives the same
// clock for the playhead and transport controls). This is the fix for the
// two-independent-players bug: exactly one player instance per project.
export function EditorStage() {
  const videoElA = useRef<HTMLVideoElement>(null);
  const videoElB = useRef<HTMLVideoElement>(null);
  const player = useTimelinePlayer(videoElA, videoElB);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0a0c10] text-gray-100">
      <GenerationPoller />
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[320px] shrink-0 flex-col">
          <ChatPanel />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <div className="w-[280px] shrink-0">
              <MediaLibrary />
            </div>
            <div className="min-w-0 flex-1">
              <PreviewPlayer player={player} videoElA={videoElA} videoElB={videoElB} />
            </div>
            <div className="w-[260px] shrink-0">
              <InspectorPanel />
            </div>
          </div>
          <div className="h-[220px] shrink-0 border-t border-white/10">
            <TimelinePanel player={player} />
          </div>
        </div>
      </div>
    </div>
  );
}
