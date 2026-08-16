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

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "timeline_add_clip",
    description:
      "Add a video from the media library to the timeline as a new sequenced clip. Use the mediaId from the CURRENT LIBRARY list in context. Appends to the end by default.",
    input_schema: {
      type: "object",
      properties: {
        media_id: { type: "string", description: "The library item id of the video to add." },
        trim_in: { type: "number", description: "Optional start offset in seconds. Defaults to 0." },
        trim_out: { type: "number", description: "Optional end offset in seconds. Defaults to the full source duration." },
        order: { type: "number", description: "Optional position (0-based). Defaults to appended at the end." },
      },
      required: ["media_id"],
    },
  },
  {
    name: "timeline_trim_clip",
    description: "Change the in/out points of a clip already on the timeline.",
    input_schema: {
      type: "object",
      properties: {
        clip_id: { type: "string", description: "The timeline clip id, from CURRENT TIMELINE in context." },
        trim_in: { type: "number" },
        trim_out: { type: "number" },
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
];
