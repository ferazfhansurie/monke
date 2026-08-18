"use client";

import { useRef } from "react";
import { TopBar } from "./top-bar";
import { ChatPanel } from "./chat-panel";
import { MediaLibrary } from "./media-library";
import { PreviewPlayer } from "./preview-player";
import { InspectorPanel } from "./inspector-panel";
import { TimelinePanel } from "./timeline-panel";
import { GenerationPoller } from "./generation-poller";
import { ResizeHandle } from "./resize-handle";
import { useTimelinePlayer } from "@/lib/timeline-player";
import { usePanelSize } from "@/lib/use-panel-size";

// Owns the single shared playback engine (video element refs +
// useTimelinePlayer) and hands it to both PreviewPlayer (which renders the
// visible <video> tags) and TimelinePanel (which reads/drives the same
// clock for the playhead and transport controls). This is the fix for the
// two-independent-players bug: exactly one player instance per project.
export function EditorStage() {
  const videoElA = useRef<HTMLVideoElement>(null);
  const videoElB = useRef<HTMLVideoElement>(null);
  const player = useTimelinePlayer(videoElA, videoElB);

  // Persisted, drag-resizable panel sizes — every panel used to be a
  // hardcoded pixel width with no way to resize it and overflow-hidden at
  // the root silently clipping anything that didn't fit a narrower window.
  // Min/max keep a drag (or a stale localStorage value from a since-resized
  // window) from ever collapsing a panel to something unusable.
  const [chatWidth, resizeChat] = usePanelSize("chat", 320, 260, 640);
  const [libraryWidth, resizeLibrary] = usePanelSize("library", 280, 200, 520);
  const [inspectorWidth, resizeInspector] = usePanelSize("inspector", 260, 220, 520);
  const [timelineHeight, resizeTimeline] = usePanelSize("timeline", 220, 140, 560);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0a0c10] text-gray-100">
      <GenerationPoller />
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <div className="flex shrink-0 flex-col overflow-hidden" style={{ width: chatWidth }}>
          <ChatPanel />
        </div>
        <ResizeHandle direction="horizontal" onResize={resizeChat} />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1">
            <div className="shrink-0 overflow-hidden" style={{ width: libraryWidth }}>
              <MediaLibrary />
            </div>
            <ResizeHandle direction="horizontal" onResize={resizeLibrary} />
            <div className="min-w-0 flex-1 overflow-hidden">
              <PreviewPlayer player={player} videoElA={videoElA} videoElB={videoElB} />
            </div>
            <ResizeHandle direction="horizontal" onResize={(d) => resizeInspector(-d)} />
            <div className="shrink-0 overflow-hidden" style={{ width: inspectorWidth }}>
              <InspectorPanel />
            </div>
          </div>
          <ResizeHandle direction="vertical" onResize={(d) => resizeTimeline(-d)} />
          <div className="shrink-0 overflow-hidden border-t border-white/10" style={{ height: timelineHeight }}>
            <TimelinePanel player={player} />
          </div>
        </div>
      </div>
    </div>
  );
}
