"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
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

function Section({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-white/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2.5 text-[11px] font-semibold text-gray-200 hover:bg-white/[0.02] transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
      </button>
      {open && <div className="px-3 pb-2">{children}</div>}
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
    <div className="flex h-full flex-col overflow-y-auto border-l border-white/10 bg-[#0d1117] text-gray-300">
      <Section title="Project">
        <Field label="Name">
          <span className="max-w-[140px] truncate text-[11px] text-gray-300">{projectName}</span>
        </Field>
        <Field label="Source">
          <span className="max-w-[140px] truncate text-[11px] text-gray-500">{folderHandle ? "Local folder" : "None"}</span>
        </Field>
        <Field label="Duration">
          <span className="text-[11px] text-gray-300">{durationSec.toFixed(1)}s</span>
        </Field>
      </Section>

      <Section title="Settings">
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
      </Section>

      <Section title="Keyboard Shortcuts" defaultOpen={false}>
        {[
          ["Space", "Play / pause"],
          ["S", "Split at playhead"],
          ["Delete", "Remove selected clip"],
          ["← / →", "Nudge playhead 1 frame"],
        ].map(([key, desc]) => (
          <div key={key} className="flex items-center justify-between py-1">
            <span className="text-[11px] text-gray-500">{desc}</span>
            <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-gray-400">{key}</kbd>
          </div>
        ))}
      </Section>
    </div>
  );
}
