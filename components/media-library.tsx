"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { FolderOpen, Import, Search, LayoutGrid, Film, Music, Image as ImageIcon, RefreshCw } from "lucide-react";
import { useMonkeStore } from "@/lib/store";
import { openProjectFolder, listMediaHandles, buildMediaItem, isFileSystemAccessSupported } from "@/lib/fs";

function fmtDuration(sec?: number) {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function MediaLibrary() {
  const items = useMonkeStore((s) => s.items);
  const selectedItemId = useMonkeStore((s) => s.selectedItemId);
  const selectItem = useMonkeStore((s) => s.selectItem);
  const addItem = useMonkeStore((s) => s.addItem);
  const addTimelineClip = useMonkeStore((s) => s.addTimelineClip);
  const setFolder = useMonkeStore((s) => s.setFolder);
  const isLoadingFolder = useMonkeStore((s) => s.isLoadingFolder);
  const setLoadingFolder = useMonkeStore((s) => s.setLoadingFolder);
  const loadProgress = useMonkeStore((s) => s.loadProgress);
  const setLoadProgress = useMonkeStore((s) => s.setLoadProgress);
  const projectName = useMonkeStore((s) => s.projectName);
  const folderNeedsReconnect = useMonkeStore((s) => s.folderNeedsReconnect);
  const reconnectFolder = useMonkeStore((s) => s.reconnectFolder);
  const [reconnecting, setReconnecting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const filteredItems = useMemo(
    () => (query.trim() ? items.filter((i) => i.name.toLowerCase().includes(query.trim().toLowerCase())) : items),
    [items, query]
  );

  const importFolder = useCallback(async () => {
    if (!isFileSystemAccessSupported()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const dir = await openProjectFolder();
      setFolder(dir, dir.name);
      setLoadingFolder(true);
      const handles = await listMediaHandles(dir);
      setLoadProgress({ done: 0, total: handles.length });
      for (let i = 0; i < handles.length; i++) {
        const item = await buildMediaItem(handles[i].handle, handles[i].kind);
        addItem(item);
        setLoadProgress({ done: i + 1, total: handles.length });
      }
    } catch (err) {
      // AbortError = user cancelled the picker — not a real failure.
      if (err instanceof Error && err.name !== "AbortError") {
        console.error("Failed to open folder:", err);
      }
    } finally {
      setLoadingFolder(false);
      setLoadProgress(null);
    }
  }, [setFolder, setLoadingFolder, setLoadProgress, addItem]);

  // Fallback for browsers without the File System Access API (Safari,
  // Firefox): a plain multi-file input. No folder handle, no write-back —
  // just read the picked files into the library.
  const importFilesFallback = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      setLoadingFolder(true);
      setLoadProgress({ done: 0, total: files.length });
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const kind = file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : file.type.startsWith("image/") ? "image" : null;
        if (kind) {
          // Fake a minimal FileSystemFileHandle-shaped wrapper so the rest
          // of the app doesn't need a second code path.
          const pseudoHandle = {
            kind: "file" as const,
            name: file.name,
            getFile: async () => file,
          } as unknown as FileSystemFileHandle;
          const item = await buildMediaItem(pseudoHandle, kind);
          addItem(item);
        }
        setLoadProgress({ done: i + 1, total: files.length });
      }
      setLoadingFolder(false);
      setLoadProgress(null);
      e.target.value = "";
    },
    [addItem, setLoadingFolder, setLoadProgress]
  );

  const KindIcon = { video: Film, audio: Music, image: ImageIcon } as const;

  return (
    <div className="flex h-full flex-col border-r border-white/10 bg-[#0d1117]">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-2 py-2">
        <button
          type="button"
          onClick={importFolder}
          className="flex items-center gap-1.5 rounded-md bg-white/5 hover:bg-white/10 px-2 py-1.5 text-[11px] font-semibold text-gray-200 transition-colors"
        >
          <FolderOpen className="h-3.5 w-3.5" /> Open Folder
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 rounded-md bg-white/5 hover:bg-white/10 px-2 py-1.5 text-[11px] font-semibold text-gray-200 transition-colors"
        >
          <Import className="h-3.5 w-3.5" /> Import
        </button>
        <input ref={fileInputRef} type="file" accept="video/*,audio/*,image/*" multiple className="hidden" onChange={importFilesFallback} />
        <div className="flex-1" />
        <LayoutGrid className="h-3.5 w-3.5 text-gray-500" />
      </div>

      <div className="border-b border-white/10 px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-1">
          <Search className="h-3 w-3 text-gray-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-full bg-transparent text-[11px] text-gray-300 placeholder:text-gray-600 outline-none"
          />
        </div>
      </div>

      <div className="flex items-center justify-between px-2.5 py-2 text-[10px] text-gray-500">
        <span>Library</span>
        <span>{query.trim() ? `${filteredItems.length} of ${items.length}` : `${items.length} items`}</span>
      </div>

      {loadProgress && (
        <div className="px-2.5 pb-2 text-[10px] text-[#f26522]">
          Loading {loadProgress.done}/{loadProgress.total}…
        </div>
      )}

      {folderNeedsReconnect && (
        <div className="mx-2 mb-2 flex flex-col gap-1.5 rounded-md border border-[#f26522]/30 bg-[#f26522]/5 px-2.5 py-2">
          <p className="text-[10px] text-gray-300">
            This project&apos;s saved footage folder needs permission again after the reload — your browser only remembers access for a
            while.
          </p>
          <button
            type="button"
            disabled={reconnecting}
            onClick={async () => {
              setReconnecting(true);
              await reconnectFolder();
              setReconnecting(false);
            }}
            className="flex items-center justify-center gap-1.5 self-start rounded-md bg-[#f26522] px-2 py-1 text-[10px] font-semibold text-white hover:bg-[#d9541a] disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`h-3 w-3 ${reconnecting ? "animate-spin" : ""}`} /> Reconnect Folder
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {items.length === 0 && !isLoadingFolder ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <FolderOpen className="h-8 w-8 text-gray-700" />
            <p className="text-[11px] text-gray-500">
              {folderNeedsReconnect
                ? "Click Reconnect Folder above to restore your media."
                : projectName === "Untitled Project"
                  ? "Open a folder of footage to get started."
                  : "No media in this folder yet."}
            </p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-[11px] text-gray-500">No media matches &ldquo;{query}&rdquo;.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {filteredItems.map((item) => {
              const Icon = KindIcon[item.kind];
              const isSelected = selectedItemId === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectItem(item.id)}
                  onDoubleClick={() => item.kind === "video" && addTimelineClip(item.id, { trimIn: 0, trimOut: item.durationSec })}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("application/monke-media-id", item.id)}
                  className={`group relative aspect-video overflow-hidden rounded-md border ${
                    isSelected ? "border-[#f26522]" : "border-white/10 hover:border-white/25"
                  } bg-black text-left`}
                  title={`${item.name}${item.kind === "video" ? " — double-click to add to timeline" : ""}`}
                >
                  {item.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.thumbnailUrl} alt={item.name} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <Icon className="h-5 w-5 text-gray-600" />
                    </div>
                  )}
                  {item.durationSec != null && (
                    <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[9px] font-mono text-white">{fmtDuration(item.durationSec)}</span>
                  )}
                  <span className="absolute bottom-0 left-0 right-0 truncate bg-gradient-to-t from-black/80 to-transparent px-1 pb-0.5 pt-3 text-[9px] text-white/90">
                    {item.name}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
