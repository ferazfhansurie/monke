"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMonkeStore } from "@/lib/store";
import { FULL_FRAME, DEFAULT_PIP_RECT } from "@/lib/layer-style";
import { GOOGLE_FONTS } from "@/lib/fonts";
import type { ClipMask, ClipRect } from "@/lib/types";
import { clipDuration, clipSpeed, motionPreset } from "@/lib/timeline-math";
import { hasGrade } from "@/lib/grade";
import { captionStyle, type CaptionStyleKind } from "@/lib/captions";

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

function GradeSlider({
  label,
  value,
  onChange,
  min = -1,
  max = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="w-16 shrink-0 text-[11px] text-gray-500">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        // Double-click resets to neutral — grading is iterative and getting
        // back to zero by dragging is fiddly.
        onDoubleClick={() => onChange(0)}
        title="Double-click to reset"
        className="min-w-0 flex-1 accent-[#f26522]"
      />
      <span className="w-9 shrink-0 text-right font-mono text-[10px] text-gray-600 tabular-nums">
        {value === 0 ? "0" : value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2)}
      </span>
    </div>
  );
}

function PctInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      value={Math.round(value * 100)}
      onChange={(e) => onChange(Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100)}
      className="w-14 rounded bg-white/5 px-1.5 py-0.5 text-right text-[11px] text-gray-300 outline-none"
    />
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
  const items = useMonkeStore((s) => s.items);
  const selectedClipId = useMonkeStore((s) => s.selectedClipId);
  const updateTimelineClip = useMonkeStore((s) => s.updateTimelineClip);
  const selectedCaptionId = useMonkeStore((s) => s.selectedCaptionId);
  const updateCaption = useMonkeStore((s) => s.updateCaption);

  const durationSec = timeline.clips.filter((c) => (c.trackIndex ?? 0) === 0).reduce((sum, c) => sum + clipDuration(c), 0);
  const selectedClip = timeline.clips.find((c) => c.id === selectedClipId);
  const selectedItem = selectedClip ? items.find((i) => i.id === selectedClip.mediaId) : undefined;
  const position: ClipRect = selectedClip?.position ?? FULL_FRAME;
  const selectedCaption = timeline.captions.find((c) => c.id === selectedCaptionId);

  return (
    <div className="flex h-full flex-col overflow-y-auto border-l border-white/10 bg-[#0d1117] text-gray-300">


      <div className="flex items-baseline justify-between gap-2 border-b border-white/10 px-3 py-2.5">
        <span className="truncate text-[11px] font-semibold text-gray-200">{projectName}</span>
        <span className="shrink-0 font-mono text-[10px] text-gray-600">
          {durationSec.toFixed(1)}s · {settings.aspectRatio}
        </span>
      </div>

      {!selectedClip && !selectedCaption && (
        <div className="px-3 py-6 text-[11px] leading-relaxed text-gray-600">
          Select a clip or caption on the timeline to edit it.
        </div>
      )}

      {selectedClip && (
        <Section title="Layer & Mask">
          <Field label="Clip">
            <span className="max-w-[140px] truncate text-[11px] text-gray-300">{selectedItem?.name ?? selectedClip.mediaId}</span>
          </Field>
          <Field label="Track">
            <input
              type="number"
              min={0}
              value={selectedClip.trackIndex ?? 0}
              onChange={(e) => {
                const trackIndex = Math.max(0, Math.round(Number(e.target.value) || 0));
                if (trackIndex === 0) {
                  updateTimelineClip(selectedClip.id, { trackIndex, position: undefined, timelineStart: undefined, opacity: undefined, mask: undefined });
                } else {
                  updateTimelineClip(selectedClip.id, {
                    trackIndex,
                    timelineStart: selectedClip.timelineStart ?? 0,
                    position: selectedClip.position ?? DEFAULT_PIP_RECT,
                  });
                }
              }}
              className="w-14 rounded bg-white/5 px-1.5 py-0.5 text-right text-[11px] text-gray-300 outline-none"
            />
          </Field>
          {(selectedClip.trackIndex ?? 0) > 0 && (
            <Field label="Starts at">
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={selectedClip.timelineStart ?? 0}
                  onChange={(e) => updateTimelineClip(selectedClip.id, { timelineStart: Math.max(0, Number(e.target.value) || 0) })}
                  className="w-16 rounded bg-white/5 px-1.5 py-0.5 text-right text-[11px] text-gray-300 outline-none"
                />
                <span className="text-[10px] text-gray-600">s</span>
              </div>
            </Field>
          )}

          <div className="py-1 text-[10px] font-medium text-gray-600">Position</div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
            {(["x", "y", "width", "height"] as const).map((key) => (
              <label key={key} className="flex items-center justify-between text-[10px] text-gray-500">
                {key}
                <PctInput value={position[key]} onChange={(v) => updateTimelineClip(selectedClip.id, { position: { ...position, [key]: v } })} />
              </label>
            ))}
          </div>

          <Field label="Speed">
            <div className="flex items-center gap-1">
              <select
                value={clipSpeed(selectedClip)}
                onChange={(e) => updateTimelineClip(selectedClip.id, { speed: Number(e.target.value) })}
                className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-gray-300 outline-none"
              >
                {[0.25, 0.5, 1, 1.5, 2, 3, 4].map((sp) => (
                  <option key={sp} value={sp}>
                    {sp}×
                  </option>
                ))}
              </select>
              <span className="w-14 text-right font-mono text-[10px] text-gray-600">
                {clipDuration(selectedClip).toFixed(1)}s
              </span>
            </div>
          </Field>

          <Field label="Opacity">
            <PctInput value={selectedClip.opacity ?? 1} onChange={(v) => updateTimelineClip(selectedClip.id, { opacity: v })} />
          </Field>

          <div className="flex items-center justify-between py-1">
            <span className="text-[10px] font-medium text-gray-600">Colour</span>
            {hasGrade(selectedClip.grade) && (
              <button
                type="button"
                onClick={() => updateTimelineClip(selectedClip.id, { grade: undefined })}
                className="rounded px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-white/10 hover:text-gray-300"
              >
                Reset
              </button>
            )}
          </div>
          {([
            ["Exposure", "exposure"],
            ["Contrast", "contrast"],
            ["Saturation", "saturation"],
            ["Temp", "temperature"],
            ["Tint", "tint"],
            ["Lift", "lift"],
          ] as const).map(([label, key]) => (
            <GradeSlider
              key={key}
              label={label}
              value={selectedClip.grade?.[key] ?? 0}
              onChange={(v) => updateTimelineClip(selectedClip.id, { grade: { ...selectedClip.grade, [key]: v } })}
            />
          ))}

          <div className="py-1 text-[10px] font-medium text-gray-600">Motion</div>
          <div className="grid grid-cols-2 gap-1 pb-1">
            {([
              ["push-in", "Push in"],
              ["pull-out", "Pull out"],
              ["pan-left", "Pan left"],
              ["pan-right", "Pan right"],
            ] as const).map(([kind, label]) => {
              const active = (selectedClip.keyframes?.length ?? 0) > 0 && selectedClip.motionKind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() =>
                    updateTimelineClip(selectedClip.id, { keyframes: motionPreset(kind), motionKind: kind })
                  }
                  className={`rounded px-1.5 py-1 text-[10px] transition-colors ${
                    active ? "bg-[#f26522]/20 text-[#f26522]" : "bg-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {(selectedClip.keyframes?.length ?? 0) > 0 && (
            <Field label="Easing">
              <div className="flex items-center gap-1">
                <select
                  value={selectedClip.easing ?? "ease"}
                  onChange={(e) => updateTimelineClip(selectedClip.id, { easing: e.target.value as "linear" | "ease" })}
                  className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-gray-300 outline-none"
                >
                  <option value="ease">Smooth</option>
                  <option value="linear">Linear</option>
                </select>
                <button
                  type="button"
                  onClick={() => updateTimelineClip(selectedClip.id, { keyframes: undefined, motionKind: undefined })}
                  className="rounded px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-white/10 hover:text-gray-300"
                  title="Remove motion"
                >
                  Clear
                </button>
              </div>
            </Field>
          )}

          <Field label="Fade from black">
            <div className="flex items-center gap-1">
              <input
                type="number"
                step={0.1}
                min={0}
                value={selectedClip.videoFadeInSec ?? 0}
                onChange={(e) => updateTimelineClip(selectedClip.id, { videoFadeInSec: Math.max(0, Number(e.target.value) || 0) })}
                className="w-14 rounded bg-white/5 px-1.5 py-0.5 text-right text-[11px] text-gray-300 outline-none"
              />
              <span className="text-[10px] text-gray-600">s</span>
            </div>
          </Field>
          <Field label="Fade to black">
            <div className="flex items-center gap-1">
              <input
                type="number"
                step={0.1}
                min={0}
                value={selectedClip.videoFadeOutSec ?? 0}
                onChange={(e) => updateTimelineClip(selectedClip.id, { videoFadeOutSec: Math.max(0, Number(e.target.value) || 0) })}
                className="w-14 rounded bg-white/5 px-1.5 py-0.5 text-right text-[11px] text-gray-300 outline-none"
              />
              <span className="text-[10px] text-gray-600">s</span>
            </div>
          </Field>

          <div className="py-1 text-[10px] font-medium text-gray-600">Audio</div>
          <Field label="Fade in">
            <div className="flex items-center gap-1">
              <input
                type="number"
                step={0.1}
                min={0}
                value={selectedClip.fadeInSec ?? 0}
                onChange={(e) => updateTimelineClip(selectedClip.id, { fadeInSec: Math.max(0, Number(e.target.value) || 0) })}
                className="w-14 rounded bg-white/5 px-1.5 py-0.5 text-right text-[11px] text-gray-300 outline-none"
              />
              <span className="text-[10px] text-gray-600">s</span>
            </div>
          </Field>
          <Field label="Fade out">
            <div className="flex items-center gap-1">
              <input
                type="number"
                step={0.1}
                min={0}
                value={selectedClip.fadeOutSec ?? 0}
                onChange={(e) => updateTimelineClip(selectedClip.id, { fadeOutSec: Math.max(0, Number(e.target.value) || 0) })}
                className="w-14 rounded bg-white/5 px-1.5 py-0.5 text-right text-[11px] text-gray-300 outline-none"
              />
              <span className="text-[10px] text-gray-600">s</span>
            </div>
          </Field>
          <Field label="Volume">
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((selectedClip.volume ?? 1) * 100)}
              onChange={(e) => updateTimelineClip(selectedClip.id, { volume: Number(e.target.value) / 100 })}
              disabled={selectedClip.muted ?? false}
              className="w-20 accent-[#f26522] disabled:opacity-30"
            />
          </Field>
          <Field label="Mute">
            <input
              type="checkbox"
              checked={selectedClip.muted ?? (selectedClip.trackIndex ?? 0) > 0}
              onChange={(e) => updateTimelineClip(selectedClip.id, { muted: e.target.checked })}
              className="accent-[#f26522]"
            />
          </Field>

          <div className="py-1 text-[10px] font-medium text-gray-600">Mask</div>
          <Field label="Shape">
            <select
              value={selectedClip.mask?.shape ?? "none"}
              onChange={(e) => {
                const shape = e.target.value;
                if (shape !== "rect" && shape !== "ellipse") {
                  updateTimelineClip(selectedClip.id, { mask: undefined });
                  return;
                }
                const m = selectedClip.mask;
                updateTimelineClip(selectedClip.id, {
                  mask: { shape, insetTop: m?.insetTop ?? 0, insetRight: m?.insetRight ?? 0, insetBottom: m?.insetBottom ?? 0, insetLeft: m?.insetLeft ?? 0 },
                });
              }}
              className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-gray-300 outline-none"
            >
              <option value="none">None</option>
              <option value="rect">Rectangle</option>
              <option value="ellipse">Ellipse</option>
            </select>
          </Field>
          {selectedClip.mask && (
            <div className="grid grid-cols-2 gap-x-2 gap-y-1">
              {(["insetTop", "insetRight", "insetBottom", "insetLeft"] as const).map((key) => (
                <label key={key} className="flex items-center justify-between text-[10px] text-gray-500">
                  {key.replace("inset", "")}
                  <PctInput
                    value={(selectedClip.mask as ClipMask)[key]}
                    onChange={(v) => updateTimelineClip(selectedClip.id, { mask: { ...(selectedClip.mask as ClipMask), [key]: v } })}
                  />
                </label>
              ))}
            </div>
          )}
        </Section>
      )}

      {selectedCaption && (
        <Section title="Caption">
          <textarea
            value={selectedCaption.text}
            onChange={(e) => updateCaption(selectedCaption.id, { text: e.target.value })}
            rows={2}
            className="mb-2 w-full resize-none rounded bg-white/5 px-2 py-1.5 text-[12px] text-gray-200 outline-none"
          />
          <div className="py-1 text-[10px] font-medium text-gray-600">Style</div>
          <div className="grid grid-cols-3 gap-1 pb-1">
            {([
              ["subtitle", "Subtitle"],
              ["band", "Band"],
              ["title", "Title card"],
            ] as [CaptionStyleKind, string][]).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                onClick={() => updateCaption(selectedCaption.id, captionStyle(kind))}
                className="rounded bg-white/5 px-1.5 py-1 text-[10px] text-gray-400 hover:bg-white/10 hover:text-gray-200 transition-colors"
              >
                {label}
              </button>
            ))}
          </div>
          <Field label="Fade">
            <div className="flex items-center gap-1">
              <input
                type="number"
                step={0.1}
                min={0}
                value={selectedCaption.fadeSec ?? 0}
                onChange={(e) => updateCaption(selectedCaption.id, { fadeSec: Math.max(0, Number(e.target.value) || 0) })}
                className="w-14 rounded bg-white/5 px-1.5 py-0.5 text-right text-[11px] text-gray-300 outline-none"
              />
              <span className="text-[10px] text-gray-600">s</span>
            </div>
          </Field>

          <Field label="Font">
            <select
              value={selectedCaption.fontFamily}
              onChange={(e) => updateCaption(selectedCaption.id, { fontFamily: e.target.value })}
              className="max-w-[140px] rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-gray-300 outline-none"
            >
              {GOOGLE_FONTS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Size">
            <input
              type="number"
              min={12}
              max={200}
              value={selectedCaption.fontSize}
              onChange={(e) => updateCaption(selectedCaption.id, { fontSize: Math.max(12, Number(e.target.value) || 64) })}
              className="w-14 rounded bg-white/5 px-1.5 py-0.5 text-right text-[11px] text-gray-300 outline-none"
            />
          </Field>
          <Field label="Color">
            <input
              type="color"
              value={selectedCaption.color}
              onChange={(e) => updateCaption(selectedCaption.id, { color: e.target.value })}
              className="h-6 w-10 rounded bg-white/5 outline-none"
            />
          </Field>
          <Field label="Bold">
            <input
              type="checkbox"
              checked={selectedCaption.bold ?? false}
              onChange={(e) => updateCaption(selectedCaption.id, { bold: e.target.checked })}
              className="accent-[#f26522]"
            />
          </Field>
          <Field label="Start">
            <div className="flex items-center gap-1">
              <input
                type="number"
                step={0.1}
                min={0}
                value={selectedCaption.start}
                onChange={(e) => updateCaption(selectedCaption.id, { start: Math.max(0, Number(e.target.value) || 0) })}
                className="w-16 rounded bg-white/5 px-1.5 py-0.5 text-right text-[11px] text-gray-300 outline-none"
              />
              <span className="text-[10px] text-gray-600">s</span>
            </div>
          </Field>
          <Field label="End">
            <div className="flex items-center gap-1">
              <input
                type="number"
                step={0.1}
                min={0}
                value={selectedCaption.end}
                onChange={(e) => updateCaption(selectedCaption.id, { end: Math.max(selectedCaption.start + 0.1, Number(e.target.value) || selectedCaption.start + 1) })}
                className="w-16 rounded bg-white/5 px-1.5 py-0.5 text-right text-[11px] text-gray-300 outline-none"
              />
              <span className="text-[10px] text-gray-600">s</span>
            </div>
          </Field>

          <div className="py-1 text-[10px] font-medium text-gray-600">Position</div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
            {(["x", "y", "width", "height"] as const).map((key) => (
              <label key={key} className="flex items-center justify-between text-[10px] text-gray-500">
                {key}
                <PctInput value={selectedCaption.position[key]} onChange={(v) => updateCaption(selectedCaption.id, { position: { ...selectedCaption.position, [key]: v } })} />
              </label>
            ))}
          </div>
        </Section>
      )}

      <Section title="Project" defaultOpen={false}>
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

      <Section title="Settings" defaultOpen={false}>
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
          ["J / K / L", "Back 1s / pause / play"],
          ["S", "Split at playhead"],
          ["⌘D", "Duplicate selection"],
          ["⌘C / ⌘V", "Copy / paste clips"],
          ["⇧ click", "Add to selection"],
          ["Delete", "Remove selection"],
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
