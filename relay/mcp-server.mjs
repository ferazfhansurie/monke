#!/usr/bin/env node
// Spawned by `claude -p --mcp-config` as a stdio subprocess, once per turn.
// It doesn't execute tools itself — MONKe's tools (probe a frame, transcribe
// audio, bake a cutout matte) all need real browser APIs (canvas, <video>,
// WASM models) that a Node subprocess has no access to. Instead it forwards
// each CallToolRequest to the long-running relay process over localhost
// HTTP (server.mjs's /internal/dispatch-tool), which bridges it to whichever
// browser tab is connected over WebSocket, waits for that tab to actually
// run the tool via chat-panel.tsx's own dispatchTool(), and hands the result
// back here to return to Claude.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_TOOLS } from "../lib/agent-tools.ts";

const relayPort = process.argv[2] || process.env.MONKE_RELAY_PORT || "8137";
const relayUrl = `http://127.0.0.1:${relayPort}`;

const server = new Server({ name: "monke", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: AGENT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const res = await fetch(`${relayUrl}/internal/dispatch-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, input: args ?? {} }),
    });
    const data = await res.json();
    return {
      content: [
        { type: "text", text: data.message ?? "" },
        ...(Array.isArray(data.imageDataUrls) ? data.imageDataUrls.map((url) => ({ type: "image", data: url.split(",")[1] ?? url, mimeType: "image/jpeg" })) : []),
      ],
      isError: data.ok === false,
    };
  } catch (err) {
    return { content: [{ type: "text", text: `Relay unreachable or the browser tab isn't connected: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
