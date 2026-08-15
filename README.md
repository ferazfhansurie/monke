# MONKe

A local-first, AI-native video editor. Under ADletic.

Open a folder of raw footage straight from your machine (Chrome's File
System Access API — the same "Open Folder" flow VSCode uses, no upload
step) and cut it with an AI agent that can see and hear your clips.

## Why local-first

Every AI video tool today assumes you already have one clean asset to
edit. MONKe assumes the opposite, more common case: a pile of messy
phone clips and no time to assemble them. Files never leave your
machine — only the derived artifacts an AI editing agent needs
(transcripts, probed frames) are ever sent out, and only when it's
actually looking at that clip.

**Browser support:** Chrome/Edge 86+ only for the folder-open flow
(File System Access API isn't supported in Safari or Firefox). A
manual multi-file picker is the fallback there — footage loads, but
there's no folder handle to write exports back to.

## Status

Phase 1 (this commit): editor shell, folder-open + media library,
single-track timeline with trim/split/reorder, sequenced multi-clip
playback. The chat panel UI is complete but not yet wired to a
backend — Phase 2 adds footage indexing (transcription + frame
probing) and Claude-driven timeline tool-calling, the same proven
pattern from MotionBoards adapted to local File System Access media.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · Zustand ·
File System Access API for local media · WebCodecs planned for export
(no server-side rendering of user footage).

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — Chrome or Edge
required to exercise the folder-open flow.
