// Core data model for MONKe. A project is local-first: media files are never
// uploaded — we hold File System Access API handles and read bytes on demand.
// Only derived artifacts (transcripts, probed frames, generated voiceover)
// ever leave the browser, and only when the AI explicitly needs them.

export type MediaKind = "video" | "audio" | "image";

export interface MediaItem {
  id: string;
  name: string;
  kind: MediaKind;
  handle: FileSystemFileHandle;
  // Object URL for the underlying file, created lazily on first use and
  // revoked when the project closes. Not persisted — handles are the
  // source of truth; URLs are a runtime cache.
  objectUrl?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  addedAt: string;
}

// Where a clip renders within the frame — fractions (0-1) of the project's
// resolution, not pixels, so it's independent of resolution/aspect changes.
export interface ClipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// A point in a clip's animation. `t` is normalized 0-1 through the clip's
// ON-SCREEN life, not source seconds — so a move survives retiming and
// re-trimming instead of drifting out of range.
export interface ClipKeyframe {
  t: number;
  position?: ClipRect;
  opacity?: number;
}

// Crops a clip's rendered box. Insets are fractions (0-1) of the clip's OWN
// box (not the whole frame) — 0 means no crop on that edge.
export interface ClipMask {
  shape: "rect" | "ellipse";
  insetTop: number;
  insetRight: number;
  insetBottom: number;
  insetLeft: number;
}

export interface TimelineClip {
  id: string;
  mediaId: string; // references MediaItem.id — media is never duplicated
  trimIn: number; // seconds into the source
  trimOut: number; // seconds into the source
  order: number; // sequencing WITHIN track 0 (base track); unused/ignored for trackIndex > 0
  // trackIndex 0 = the base track: clips play back-to-back, sequenced by
  // `order`, and define the timeline's overall duration. trackIndex > 0 =
  // an overlay track: the clip floats at an explicit `timelineStart` on the
  // master clock, independent of base-track sequencing, and renders on top
  // (higher trackIndex = higher z-order). Omitted = 0, for clips created
  // before layering existed.
  trackIndex?: number;
  timelineStart?: number; // seconds on the master timeline — REQUIRED for trackIndex > 0
  position?: ClipRect; // defaults to full-frame {x:0,y:0,width:1,height:1} when unset
  opacity?: number; // 0-1, defaults to 1
  mask?: ClipMask;
  volume?: number; // 0-1, defaults to 1. Overlay clips (trackIndex > 0) default to muted instead — see `muted`.
  muted?: boolean; // defaults to false for base-track clips, true for overlay clips (avoids surprise second audio track under the base clip's own sound)
  // Person cutout (background removed via ML matting, see lib/segmentation.ts)
  // is applied for this clip's whole on-screen duration once baked. The
  // actual per-frame alpha data lives in the store's non-persisted
  // cutoutFrames map (keyed by this clip's id) — this flag alone survives a
  // reload, but the baked frames don't, so cutout needs re-baking after one.
  cutout?: boolean;
  // Playback multiplier (1 = normal). A clip at 2x occupies half as much
  // timeline as its source range — see lib/timeline-math.ts, which owns
  // that relationship so no caller recomputes it wrongly.
  speed?: number;
  // Audio ramps, in TIMELINE seconds from each end of the clip. Abrupt
  // volume cuts at an edit point are audible as a click or a slam; these
  // are what make a cut sound intentional.
  fadeInSec?: number;
  fadeOutSec?: number;
  // Fade to/from black. A dip-to-black transition is this on the outgoing
  // clip plus the same on the incoming one — no timeline overlap needed,
  // which is why it works without changing the layout model.
  videoFadeInSec?: number;
  videoFadeOutSec?: number;
  // Animated position/opacity. When present these override the static
  // `position`/`opacity` above for the frames they cover — the static
  // values remain the fallback so a clip without motion is unchanged.
  keyframes?: ClipKeyframe[];
  easing?: "linear" | "ease";
  // Which preset produced `keyframes`, so the UI can show it as selected.
  // Purely cosmetic — the keyframes are the source of truth.
  motionKind?: "push-in" | "pull-out" | "pan-left" | "pan-right";
}

// A caption is text, not media — it has no mediaId, sits on its own
// implicit layer above everything else, and positions itself the same
// fractional way as a clip's ClipRect.
export interface Caption {
  id: string;
  text: string;
  start: number; // seconds on the master timeline
  end: number;
  fontFamily: string; // a Google Fonts family name, loaded on demand
  fontSize: number; // px, relative to a 1080px-wide reference frame (scaled to actual resolution when rendered)
  color: string; // CSS color
  position: ClipRect; // fractional 0-1 frame rect the text box occupies
  bold?: boolean;
  outline?: boolean; // dark stroke/shadow for legibility over busy footage — on by default
}

export interface Timeline {
  id: string;
  name: string;
  clips: TimelineClip[];
  captions: Caption[];
}

export interface ProjectSettings {
  resolutionW: number;
  resolutionH: number;
  frameRate: number;
  aspectRatio: string; // "9:16" | "16:9" | "1:1" | "4:5" | custom
}

export interface ChatMessagePart {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  toolUseId?: string;
  isError?: boolean;
  // One or more still frames (data: URLs) captured client-side and
  // attached to a tool_result — how the agent "sees" footage without any
  // file leaving the browser except these derived frames, sent straight
  // to Anthropic. Can be a dense burst (e.g. every 0.05s) for motion.
  imageDataUrls?: string[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: ChatMessagePart[];
  createdAt: string;
}

// A past conversation, archived when "New chat" is clicked with a non-empty
// conversation — reopenable via the History button instead of being lost.
export interface ChatSession {
  id: string;
  messages: ChatMessage[];
  endedAt: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}
