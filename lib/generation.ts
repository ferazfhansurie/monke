"use client";

export interface StartGenerationOpts {
  durationSec?: number;
  resolution?: "480p" | "720p" | "1080p";
  aspectRatio?: string;
}

export type GenerationStatus =
  | { status: "processing"; requestId: string }
  | { status: "completed"; videoDataUrl: string }
  | { status: "failed"; error: string };

// The active provider (Gemini Omni Flash, see app/api/generate/video/route.ts)
// runs synchronously and returns "completed"/"failed" directly from this
// call — no polling needed. "processing" is kept in the return type for a
// provider that submits a job and polls separately (e.g. Ark, dormant since
// its API key broke) so callers don't need to change if that comes back.
export async function startVideoGeneration(prompt: string, opts?: StartGenerationOpts): Promise<GenerationStatus> {
  const res = await fetch("/api/generate/video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, durationSec: opts?.durationSec, resolution: opts?.resolution, aspectRatio: opts?.aspectRatio }),
  });
  const data = await res.json();
  if (!res.ok) return { status: "failed", error: data.error || "Failed to start generation" };
  return data as GenerationStatus;
}

export async function checkVideoGenerationStatus(requestId: string): Promise<GenerationStatus> {
  const res = await fetch(`/api/generate/video/status?requestId=${encodeURIComponent(requestId)}`);
  const data = await res.json();
  if (!res.ok) return { status: "failed", error: data.error || "Status check failed" };
  return data as GenerationStatus;
}
