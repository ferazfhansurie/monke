"use client";

import { ChevronDown } from "lucide-react";
import { useMonkeStore } from "@/lib/store";

const ASPECT_PRESETS: Record<string, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "16:9": { w: 1920, h: 1080 },
  "1:1": { w: 1080, h: 1080 },
  "4:5": { w: 1080, h: 1350 },
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[11px] text-gray-500">{label}</span>
      {children}
    </div>
  );
}

export function InspectorPanel() {
  const projectName = useMonkeStore((s) => s.projectName);
  const folderHandle = useMonkeStore((s) => s.folderHandle);
  const settings = useMonkeStore((s) => s.settings);
  const setSettings = useMonkeStore((s) => s.setSettings);
  const timeline = useMonkeStore((s) => s.timeline);

  const durationSec = timeline.clips.reduce((sum, c) => sum + Math.max(0, c.trimOut - c.trimIn), 0);

  return (
    <div className="flex h-full flex-col border-l border-white/10 bg-[#0d1117] text-gray-300">
      <div className="border-b border-white/10 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold">
          <ChevronDown className="h-3 w-3" /> Project
        </div>
      </div>
      <div className="border-b border-white/10 px-3 py-2">
        <Field label="Name">
          <span className="max-w-[140px] truncate text-[11px] text-gray-300">{projectName}</span>
        </Field>
        <Field label="Source">
          <span className="max-w-[140px] truncate text-[11px] text-gray-500">{folderHandle ? "Local folder" : "None"}</span>
        </Field>
        <Field label="Duration">
          <span className="text-[11px] text-gray-300">{durationSec.toFixed(1)}s</span>
        </Field>
      </div>

      <div className="border-b border-white/10 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold">
          <ChevronDown className="h-3 w-3" /> Settings
        </div>
      </div>
      <div className="px-3 py-2">
        <Field label="Resolution">
          <span className="text-[11px] text-gray-300">
            {settings.resolutionW} × {settings.resolutionH}
          </span>
        </Field>
        <Field label="Frame Rate">
          <select
            value={settings.frameRate}
            onChange={(e) => setSettings({ frameRate: Number(e.target.value) })}
            className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-gray-300 outline-none"
          >
            {[24, 25, 30, 60].map((fps) => (
              <option key={fps} value={fps}>
                {fps} fps
              </option>
            ))}
          </select>
        </Field>
        <Field label="Aspect Ratio">
          <select
            value={settings.aspectRatio}
            onChange={(e) => {
              const preset = ASPECT_PRESETS[e.target.value];
              setSettings({ aspectRatio: e.target.value, ...(preset ? { resolutionW: preset.w, resolutionH: preset.h } : {}) });
            }}
            className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-gray-300 outline-none"
          >
            {Object.keys(ASPECT_PRESETS).map((ar) => (
              <option key={ar} value={ar}>
                {ar}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  );
}
