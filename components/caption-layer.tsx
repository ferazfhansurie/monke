"use client";

import { useEffect, useMemo } from "react";
import { useMonkeStore } from "@/lib/store";
import { loadGoogleFont } from "@/lib/fonts";
import type { Caption } from "@/lib/types";
import { captionOpacityAt } from "@/lib/captions";

interface CaptionLayerProps {
  masterTime: number;
}

// Renders active captions as styled text overlays — always on top of every
// video layer (base track + overlays), since captions are the thing the
// viewer is meant to read last/topmost. Font size is authored relative to
// a 1080px-wide reference frame and scaled to the project's actual width
// so it stays visually consistent across aspect ratios.
export function CaptionLayer({ masterTime }: CaptionLayerProps) {
  const captions = useMonkeStore((s) => s.timeline.captions);
  const resolutionW = useMonkeStore((s) => s.settings.resolutionW);

  const active = useMemo(() => captions.filter((c) => masterTime >= c.start && masterTime < c.end), [captions, masterTime]);

  useEffect(() => {
    for (const c of active) loadGoogleFont(c.fontFamily);
  }, [active]);

  const scale = resolutionW / 1080;

  return (
    <>
      {active.map((c) => (
        <CaptionBox key={c.id} caption={c} scale={scale} opacity={captionOpacityAt(c, masterTime)} />
      ))}
    </>
  );
}

function CaptionBox({ caption, scale, opacity }: { caption: Caption; scale: number; opacity: number }) {
  const rect = caption.position;
  return (
    <div
      className="absolute flex items-center justify-center px-2 text-center"
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`,
        zIndex: 1000,
        pointerEvents: "none",
        opacity,
        background: caption.background,
        borderRadius: caption.backgroundRadius ? caption.backgroundRadius * scale : undefined,
      }}
    >
      <span
        style={{
          fontFamily: `"${caption.fontFamily}", sans-serif`,
          fontSize: `${caption.fontSize * scale}px`,
          fontWeight: caption.bold ? 700 : 400,
          color: caption.color,
          lineHeight: 1.25,
          textShadow: caption.outline !== false ? "0 0 6px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.9), 1px 1px 2px rgba(0,0,0,0.9)" : undefined,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {caption.text}
      </span>
    </div>
  );
}
