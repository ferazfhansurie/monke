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
];
