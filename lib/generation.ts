"use client";

export interface StartGenerationOpts {
  durationSec?: number;
  resolution?: "480p" | "720p" | "1080p";
  aspectRatio?: string;
}

export async function startVideoGeneration(prompt: string, opts?: StartGenerationOpts): Promise<{ requestId: string }> {
  const res = await fetch("/api/generate/video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, durationSec: opts?.durationSec, resolution: opts?.resolution, aspectRatio: opts?.aspectRatio }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to start generation");
  return { requestId: data.requestId };
}

export type GenerationStatus = { status: "processing" } | { status: "completed"; videoDataUrl: string } | { status: "failed"; error: string };

export async function checkVideoGenerationStatus(requestId: string): Promise<GenerationStatus> {
  const res = await fetch(`/api/generate/video/status?requestId=${encodeURIComponent(requestId)}`);
  const data = await res.json();
  if (!res.ok) return { status: "failed", error: data.error || "Status check failed" };
  return data as GenerationStatus;
}
