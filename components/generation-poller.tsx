"use client";

import { useEffect, useRef } from "react";
import { useMonkeStore } from "@/lib/store";
import { checkVideoGenerationStatus } from "@/lib/generation";
import { importGeneratedClip } from "@/lib/fs";

const POLL_INTERVAL_MS = 10000;

// Mounted once at the app root. Kept for a provider that submits a job and
// polls separately (e.g. Ark, dormant since its API key broke) — the active
// provider (Gemini Omni Flash) runs synchronously and is imported directly
// from the chat tool call instead, so pendingGenerations normally stays
// empty and this effect is a no-op. Generation takes ~2 minutes — far longer
// than any single chat turn's budget — so this polls independently of the
// chat loop and, on completion, imports the result straight into the
// library and posts a message, whether or not the user is still watching.
export function GenerationPoller() {
  const pendingGenerations = useMonkeStore((s) => s.pendingGenerations);
  const removePendingGeneration = useMonkeStore((s) => s.removePendingGeneration);
  const addItem = useMonkeStore((s) => s.addItem);
  const addGeneratedClip = useMonkeStore((s) => s.addGeneratedClip);
  const pushMessage = useMonkeStore((s) => s.pushMessage);
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (pendingGenerations.length === 0) return;

    const interval = setInterval(async () => {
      for (const gen of pendingGenerations) {
        if (inFlightRef.current.has(gen.id)) continue;
        inFlightRef.current.add(gen.id);
        try {
          const result = await checkVideoGenerationStatus(gen.requestId);
          if (result.status === "processing") continue;

          if (result.status === "failed") {
            pushMessage("assistant", [{ type: "text", text: `Generation failed for "${gen.prompt}": ${result.error}` }]);
            removePendingGeneration(gen.id);
            continue;
          }

          // completed
          const item = await importGeneratedClip(result.videoDataUrl, gen.prompt);
          addItem(item);
          await addGeneratedClip(item);
          pushMessage("assistant", [{ type: "text", text: `🎬 Generated clip ready — added to your library as **${item.name}** ("${gen.prompt}").` }]);
          removePendingGeneration(gen.id);
        } catch (err) {
          pushMessage("assistant", [
            { type: "text", text: `Something went wrong finishing generation for "${gen.prompt}": ${err instanceof Error ? err.message : "unknown error"}` },
          ]);
          removePendingGeneration(gen.id);
        } finally {
          inFlightRef.current.delete(gen.id);
        }
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [pendingGenerations, removePendingGeneration, addItem, addGeneratedClip, pushMessage]);

  return null;
}
