"use client";

import type { MediaItem, MediaKind } from "./types";

const VIDEO_EXT = [".mp4", ".mov", ".webm", ".mkv", ".m4v"];
const AUDIO_EXT = [".mp3", ".wav", ".m4a", ".aac", ".ogg"];
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

function kindForName(name: string): MediaKind | null {
  const lower = name.toLowerCase();
  if (VIDEO_EXT.some((ext) => lower.endsWith(ext))) return "video";
  if (AUDIO_EXT.some((ext) => lower.endsWith(ext))) return "audio";
  if (IMAGE_EXT.some((ext) => lower.endsWith(ext))) return "image";
  return null;
}

// Opens the native folder picker and returns every recognized media file in
// it (one level deep — most footage dumps are flat; nested folders are a
// v2 concern). Nothing is read into memory here beyond directory listing.
export async function openProjectFolder(): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker({ id: "monke-project", mode: "readwrite" });
}

export async function listMediaHandles(
  dir: FileSystemDirectoryHandle
): Promise<{ handle: FileSystemFileHandle; kind: MediaKind }[]> {
  const out: { handle: FileSystemFileHandle; kind: MediaKind }[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind !== "file") continue;
    const kind = kindForName(entry.name);
    if (!kind) continue;
    out.push({ handle: entry as FileSystemFileHandle, kind });
  }
  return out;
}

// Probes duration/dimensions and grabs a mid-point frame as a thumbnail.
// Runs entirely in-browser via a throwaway <video>/<canvas> pair.
async function probeVideo(url: string): Promise<{ duration: number; width: number; height: number; thumbnailUrl: string }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    v.src = url;
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(v.duration / 2, v.duration - 0.05 || 0);
    };
    v.onseeked = () => {
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas unavailable"));
      ctx.drawImage(v, 0, 0);
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("Thumbnail capture failed"));
          resolve({
            duration: v.duration,
            width: v.videoWidth,
            height: v.videoHeight,
            thumbnailUrl: URL.createObjectURL(blob),
          });
        },
        "image/jpeg",
        0.7
      );
    };
    v.onerror = () => reject(new Error(`Couldn't read ${url}`));
  });
}

async function probeImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Couldn't read image"));
    img.src = url;
  });
}

export async function buildMediaItem(handle: FileSystemFileHandle, kind: MediaKind): Promise<MediaItem> {
  const file = await handle.getFile();
  const objectUrl = URL.createObjectURL(file);
  const base: MediaItem = {
    id: `media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: handle.name,
    kind,
    handle,
    objectUrl,
    addedAt: new Date().toISOString(),
  };

  try {
    if (kind === "video") {
      const { duration, width, height, thumbnailUrl } = await probeVideo(objectUrl);
      return { ...base, durationSec: duration, width, height, thumbnailUrl };
    }
    if (kind === "image") {
      const { width, height } = await probeImage(objectUrl);
      return { ...base, width, height, thumbnailUrl: objectUrl };
    }
  } catch {
    // Non-fatal — item still shows up, just without dimensions/thumbnail.
  }
  return base;
}
