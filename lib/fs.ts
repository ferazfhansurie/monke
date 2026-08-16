"use client";

import type { MediaItem, MediaKind } from "./types";

// Deliberately generous — an unrecognized extension used to mean a file
// got silently dropped with zero feedback (see kindForFile below for the
// second-layer fallback on top of this list).
const VIDEO_EXT = [".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi", ".flv", ".mpeg", ".mpg", ".3gp", ".ts"];
const AUDIO_EXT = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".wma", ".aiff", ".aif", ".opus", ".weba", ".oga", ".mp2"];
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg", ".tiff", ".tif", ".heic", ".heif"];

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export function kindForName(name: string): MediaKind | null {
  const lower = name.toLowerCase();
  if (VIDEO_EXT.some((ext) => lower.endsWith(ext))) return "video";
  if (AUDIO_EXT.some((ext) => lower.endsWith(ext))) return "audio";
  if (IMAGE_EXT.some((ext) => lower.endsWith(ext))) return "image";
  return null;
}

// Fallback for a file whose extension isn't in our curated lists above —
// trusts the browser/OS's own MIME sniffing instead of giving up. Catches
// real-world audio/video formats we didn't think to list explicitly.
export function kindForMimeType(mimeType: string): MediaKind | null {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  return null;
}

// Combines both checks and reports which one matched — used so callers can
// surface a clear reason when a file is skipped instead of silently
// dropping it (extension not recognized AND browser couldn't identify a
// MIME type either — genuinely not media, not a bug).
export async function kindForHandle(handle: FileSystemFileHandle): Promise<MediaKind | null> {
  const byName = kindForName(handle.name);
  if (byName) return byName;
  const file = await handle.getFile();
  return kindForMimeType(file.type);
}

// Opens the native folder picker and returns every recognized media file in
// it (one level deep — most footage dumps are flat; nested folders are a
// v2 concern). Nothing is read into memory here beyond directory listing.
export async function openProjectFolder(): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker({ id: "monke-project", mode: "readwrite" });
}

// Individual-file picker via the File System Access API — unlike a plain
// <input type="file"> (which only ever hands back an in-memory File, gone
// for good the moment the tab reloads), this returns REAL FileSystemFileHandles
// that can be stored in IndexedDB and reconnected after a reload, exactly
// like a folder's contents. Only the <input> fallback path (browsers
// without FSA) is truly unable to survive a reload — anything picked this
// way should persist like folder-scanned media does.
export async function pickFiles(): Promise<{ items: { handle: FileSystemFileHandle; kind: MediaKind }[]; skipped: string[] }> {
  const handles = await window.showOpenFilePicker({
    multiple: true,
    excludeAcceptAllOption: false, // keep "All Files" selectable — the accept filter below is a default view, not a hard restriction
    types: [
      {
        description: "Media",
        accept: {
          "video/*": VIDEO_EXT,
          "audio/*": AUDIO_EXT,
          "image/*": IMAGE_EXT,
        },
      },
    ],
  });
  const items: { handle: FileSystemFileHandle; kind: MediaKind }[] = [];
  const skipped: string[] = [];
  for (const handle of handles) {
    const kind = await kindForHandle(handle);
    if (kind) items.push({ handle, kind });
    else skipped.push(handle.name);
  }
  return { items, skipped };
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

// Captures a burst of still frames as downscaled JPEG data URLs — the only
// way the AI can "see" footage content, since media is never uploaded.
// Opens one video element and seeks it repeatedly (seeks are sequential —
// a video element can only be at one currentTime at a time) rather than
// one throwaway element per frame, so a dense burst (e.g. every 0.05s)
// doesn't reload/redecode the source N times.
// Reads the file fresh from the handle rather than reusing item.objectUrl
// so this works even if that URL was already revoked.
export async function captureFrames(item: MediaItem, atSecondsList: number[]): Promise<string[]> {
  const file = await item.handle.getFile();
  const url = URL.createObjectURL(file);
  const MAX_DIM = 640;
  try {
    if (item.kind === "image") {
      const frame = await new Promise<string>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          const ctx = canvas.getContext("2d");
          if (!ctx) return reject(new Error("Canvas unavailable"));
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.7));
        };
        img.onerror = () => reject(new Error("Couldn't read image"));
        img.src = url;
      });
      return atSecondsList.map(() => frame);
    }

    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.playsInline = true;
    v.src = url;
    await new Promise<void>((resolve, reject) => {
      v.onloadedmetadata = () => resolve();
      v.onerror = () => reject(new Error("Couldn't read video"));
    });

    const scale = Math.min(1, MAX_DIM / Math.max(v.videoWidth, v.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(v.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(v.videoHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");

    const frames: string[] = [];
    for (const t of atSecondsList) {
      const clamped = Math.min(Math.max(0, t), Math.max(0, v.duration - 0.02));
      await new Promise<void>((resolve, reject) => {
        const onSeeked = () => {
          v.removeEventListener("seeked", onSeeked);
          resolve();
        };
        const onErr = () => reject(new Error("Seek failed"));
        v.addEventListener("seeked", onSeeked);
        v.addEventListener("error", onErr, { once: true });
        v.currentTime = clamped;
      });
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.6));
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Deterministic (not random) so re-scanning the same folder after a reload
// reproduces the same ids — required for a persisted Timeline's clips
// (which reference MediaItem.id) to still resolve after the media library
// is rebuilt from scratch.
function mediaIdForName(name: string): string {
  return `media_${name.toLowerCase().replace(/[^a-z0-9._-]/g, "_")}`;
}

export async function buildMediaItem(handle: FileSystemFileHandle, kind: MediaKind): Promise<MediaItem> {
  const file = await handle.getFile();
  const objectUrl = URL.createObjectURL(file);
  const base: MediaItem = {
    id: mediaIdForName(handle.name),
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
