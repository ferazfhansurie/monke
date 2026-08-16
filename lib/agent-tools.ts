// Tool registry for the MONKe editing agent. One file = one source of
// truth; add a tool here, then add a matching case in chat-panel.tsx's
// dispatch. All tools mutate local Zustand state directly — nothing here
// touches a server, because the media itself never left the browser.

export interface AgentTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Shared schema fragments for layering/masking — used by both
// timeline_add_clip (creating an overlay) and timeline_trim_clip (adjusting
// one, or adding position/mask to an existing base-track clip).
const POSITION_SCHEMA = {
  type: "object",
  description:
    "Where this clip renders within the frame, as fractions of the project resolution (0-1), not pixels — resolution-independent. {x:0,y:0,width:1,height:1} is full-frame.",
  properties: {
    x: { type: "number", description: "Left edge, 0-1." },
    y: { type: "number", description: "Top edge, 0-1." },
    width: { type: "number", description: "Width, 0-1." },
    height: { type: "number", description: "Height, 0-1." },
  },
  required: ["x", "y", "width", "height"],
};

const MASK_SCHEMA = {
  type: "object",
  description:
    "Crops the clip's rendered box to a shape. Insets are fractions (0-1) of the CLIP'S OWN box (not the whole frame) — 0 means no crop on that edge. Equal insets on all sides with shape 'ellipse' gives a classic circular PiP bubble.",
  properties: {
    shape: { type: "string", enum: ["rect", "ellipse"] },
    inset_top: { type: "number" },
    inset_right: { type: "number" },
    inset_bottom: { type: "number" },
    inset_left: { type: "number" },
  },
  required: ["shape", "inset_top", "inset_right", "inset_bottom", "inset_left"],
};

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "timeline_add_clip",
    description:
      "Add a video from the media library to the timeline. Two modes: base-track (track_index 0 or omitted) appends a new sequenced clip to the end of the main cut, like a normal edit. Overlay (track_index >= 1) places a clip that floats independently at an explicit timeline_start, layered on top of the base track and any lower overlay tracks — use this for picture-in-picture, watermarks, or any 'two things visible at once' composite. Overlay clips default to a bottom-right PiP box if you don't specify position.",
    input_schema: {
      type: "object",
      properties: {
        media_id: { type: "string", description: "The library item id of the video to add." },
        trim_in: { type: "number", description: "Optional start offset in seconds. Defaults to 0." },
        trim_out: { type: "number", description: "Optional end offset in seconds. Defaults to the full source duration." },
        order: { type: "number", description: "Base-track only (track_index 0): optional position (0-based). Defaults to appended at the end." },
        track_index: { type: "number", description: "0 = base track (default, sequential). 1+ = an overlay track, layered on top — higher draws over lower." },
        timeline_start: { type: "number", description: "REQUIRED for track_index >= 1: when this overlay appears on the master timeline, in seconds." },
        position: POSITION_SCHEMA,
        opacity: { type: "number", description: "0-1, default 1. Lower for a semi-transparent watermark." },
        mask: MASK_SCHEMA,
      },
      required: ["media_id"],
    },
  },
  {
    name: "timeline_trim_clip",
    description:
      "Update an existing timeline clip: trim in/out points, and/or its layering (track_index, timeline_start) and masking (position, opacity, mask). Only pass the fields you want to change — omitted fields are left as-is.",
    input_schema: {
      type: "object",
      properties: {
        clip_id: { type: "string", description: "The timeline clip id, from CURRENT TIMELINE in context." },
        trim_in: { type: "number" },
        trim_out: { type: "number" },
        track_index: { type: "number", description: "0 = base track. 1+ = overlay track. Moving a base clip to an overlay track requires also setting timeline_start." },
        timeline_start: { type: "number", description: "For overlay clips (track_index >= 1): when it appears on the master timeline, in seconds." },
        position: POSITION_SCHEMA,
        opacity: { type: "number", description: "0-1." },
        mask: MASK_SCHEMA,
      },
      required: ["clip_id"],
    },
  },
  {
    name: "timeline_reorder_clip",
    description: "Move a clip to a new position in the timeline sequence.",
    input_schema: {
      type: "object",
      properties: {
        clip_id: { type: "string" },
        order: { type: "number" },
      },
      required: ["clip_id", "order"],
    },
  },
  {
    name: "timeline_split_clip",
    description: "Split one timeline clip into two at a given offset, measured from the start of that clip's own trimmed range (not the source media).",
    input_schema: {
      type: "object",
      properties: {
        clip_id: { type: "string" },
        at_seconds: { type: "number" },
      },
      required: ["clip_id", "at_seconds"],
    },
  },
  {
    name: "timeline_remove_clip",
    description: "Remove a clip from the timeline. Does not delete the underlying library item.",
    input_schema: {
      type: "object",
      properties: {
        clip_id: { type: "string" },
      },
      required: ["clip_id"],
    },
  },
  {
    name: "timeline_build_sequence",
    description:
      "Replace the ENTIRE timeline in one call with an ordered list of clips — the efficient, decisive way to construct or completely re-cut an edit once you've probed the footage and made a decision. Prefer this over many individual timeline_add_clip calls when building a first cut or restructuring the whole sequence.",
    input_schema: {
      type: "object",
      properties: {
        clips: {
          type: "array",
          description: "Ordered list of clips for the new timeline, first to last. This fully replaces whatever is currently on the timeline.",
          items: {
            type: "object",
            properties: {
              media_id: { type: "string", description: "Library item id, from CURRENT LIBRARY." },
              trim_in: { type: "number", description: "Start offset into the source, in seconds." },
              trim_out: { type: "number", description: "End offset into the source, in seconds." },
            },
            required: ["media_id", "trim_in", "trim_out"],
          },
        },
      },
      required: ["clips"],
    },
  },
  {
    name: "timeline_transcribe_clip",
    description:
      "Transcribe the spoken audio of a clip or library item — runs speech-to-text locally in the user's browser (no upload). Provide clip_id (transcribes within that timeline clip's trimmed range) or media_id (transcribes the raw source). Returns the full text plus a list of {text, start, end} segments with approximate timestamps in seconds, so you can find roughly where a line lands and cut/trim around it. If the clip has no audio track or is silent, says so plainly instead of erroring.",
    input_schema: {
      type: "object",
      properties: {
        clip_id: { type: "string", description: "Timeline clip id, from CURRENT TIMELINE. Use this OR media_id." },
        media_id: { type: "string", description: "Library item id, from CURRENT LIBRARY. Use this OR clip_id." },
        start_seconds: { type: "number", description: "Optional start offset (same range semantics as clip_id/media_id). Defaults to 0 (or the clip's in-point)." },
        end_seconds: { type: "number", description: "Optional end offset. Defaults to the full clip/media duration." },
      },
    },
  },
  {
    name: "generate_stock_clip",
    description:
      "Generate a short stock-style video clip from a text description (e.g. 'an airplane flying through clouds') when the user needs footage they don't have and there's no way to get it from their own files — this is the ONLY legitimate way to add footage that doesn't already exist in the library; never suggest or attempt to download footage from YouTube, Google, or any other website (copyright/ToS violations). Generation costs real money and takes roughly 2 minutes — it does NOT complete within this tool call. REQUIRES confirmed:true — you must present the plan (prompt text, duration, resolution, aspect ratio, where it'll be used) as a plain-text message in an EARLIER turn and get the user's explicit go-ahead before calling this with confirmed:true; never plan and call it in the same turn. Once called, tell the user it's started and you'll let them know when it's ready, and continue the conversation normally — the clip is auto-imported and announced in chat when done, don't poll or ask about it yourself.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "A clear visual description of the desired clip, e.g. 'a commercial airplane flying through white clouds, blue sky, seen from below'. Must match what you already showed the user in the plan." },
        duration_seconds: { type: "number", description: "4-15, default 5." },
        resolution: { type: "string", enum: ["480p", "720p", "1080p"], description: "Default 720p." },
        aspect_ratio: { type: "string", description: "e.g. '9:16' or '16:9'. Default '9:16' (match the project's vertical default unless the user's project is landscape)." },
        confirmed: {
          type: "boolean",
          description: "Must be true. Only set true after the user has explicitly confirmed the plan you presented in a previous message — never true on the first turn a generation is discussed.",
        },
      },
      required: ["prompt", "confirmed"],
    },
  },
  {
    name: "timeline_probe_clip",
    description:
      "Capture and view still frames from a clip or library item — this is your ONLY way to see what footage actually shows. Provide clip_id (samples within that timeline clip's trimmed range) or media_id (samples the raw source). By default captures a BURST of consecutive frames at true frame-level spacing (as fine as 0.05s) starting at at_seconds, so you can see motion, not just one static instant. A burst only covers a short window (frame_count * step_seconds) — call the tool again with a later at_seconds to sweep across the rest of a longer clip.",
    input_schema: {
      type: "object",
      properties: {
        clip_id: { type: "string", description: "Timeline clip id, from CURRENT TIMELINE. Use this OR media_id." },
        media_id: { type: "string", description: "Library item id, from CURRENT LIBRARY. Use this OR clip_id." },
        at_seconds: {
          type: "number",
          description:
            "Start offset in seconds for the burst. For clip_id this is relative to the clip's own trimmed range (0 = the clip's in-point). For media_id it's relative to the raw source. Defaults to the midpoint minus half the burst window.",
        },
        frame_count: {
          type: "number",
          description: "How many consecutive frames to capture in this burst. 1-12, default 6.",
        },
        step_seconds: {
          type: "number",
          description: "Spacing between consecutive frames in the burst, in seconds. 0.05-2, default 0.05 (near frame-accurate at 20fps+).",
        },
      },
    },
  },
  {
    name: "add_captions",
    description:
      "Add one or more caption text overlays to the timeline. Get the text/timing from timeline_transcribe_clip first — never invent words or timestamps for speech you haven't actually transcribed. Group short Whisper segments into readable caption lines (roughly 3-8 words / under ~40 characters per line for a vertical video) rather than dumping raw ASR segments 1:1 — you may lightly merge/split segment boundaries for readability, but don't change what was actually said.",
    input_schema: {
      type: "object",
      properties: {
        captions: {
          type: "array",
          description: "Ordered list of caption lines to add.",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              start: { type: "number", description: "Seconds on the master timeline." },
              end: { type: "number", description: "Seconds on the master timeline." },
            },
            required: ["text", "start", "end"],
          },
        },
        font_family: { type: "string", description: "A Google Fonts family name (e.g. 'Poppins', 'Bebas Neue', 'Anton', 'Inter'). Default 'Inter'." },
        font_size: { type: "number", description: "px relative to a 1080px-wide reference frame. Default 64 — large and legible for vertical/short-form video." },
        color: { type: "string", description: "CSS color. Default '#ffffff' (white with a dark outline reads well over most footage)." },
        position: {
          ...POSITION_SCHEMA,
          description: "Where captions sit in frame, fractions 0-1. Default a bottom-center band — roughly {x:0.05,y:0.78,width:0.9,height:0.15} for 9:16.",
        },
        bold: { type: "boolean", description: "Default true — bold reads better at caption sizes." },
      },
      required: ["captions"],
    },
  },
  {
    name: "update_caption",
    description: "Edit an existing caption's text, timing, or style. Only pass the fields you want to change.",
    input_schema: {
      type: "object",
      properties: {
        caption_id: { type: "string", description: "From CURRENT TIMELINE's captions list." },
        text: { type: "string" },
        start: { type: "number" },
        end: { type: "number" },
        font_family: { type: "string" },
        font_size: { type: "number" },
        color: { type: "string" },
        position: POSITION_SCHEMA,
        bold: { type: "boolean" },
      },
      required: ["caption_id"],
    },
  },
  {
    name: "remove_caption",
    description: "Remove a caption from the timeline.",
    input_schema: {
      type: "object",
      properties: { caption_id: { type: "string" } },
      required: ["caption_id"],
    },
  },
];
