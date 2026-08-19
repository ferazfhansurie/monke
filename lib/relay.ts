"use client";

// Client side of the optional personal relay (see relay/README.md) — talks
// to a small server the user runs themselves on their own Mac, which routes
// chat turns through their own Claude Code subscription instead of the
// hosted API. Entirely opt-in: every function here fails soft (returns
// false/throws a catchable error) if the relay isn't running, so nothing
// about the normal /api/chat path depends on this file at all.

const RELAY_PORT = 8137;
const RELAY_HTTP_URL = `http://localhost:${RELAY_PORT}`;
const RELAY_WS_URL = `ws://localhost:${RELAY_PORT}/bridge`;

export async function detectRelay(): Promise<boolean> {
  try {
    const res = await fetch(`${RELAY_HTTP_URL}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.ok;
  } catch {
    return false;
  }
}

export interface RelayUsage {
  /** Percent of the rolling session limit used, per Claude Code's own /usage. */
  sessionPct: number | null;
  sessionResets: string | null;
  weekPct: number | null;
  weekResets: string | null;
  fetchedAt: string;
}

export interface RelayChatResult {
  text: string;
  sessionId?: string;
  isError?: boolean;
  error?: string;
  usage?: RelayUsage;
}

export async function sendRelayMessage(
  message: string,
  timelineContext: string,
  sessionId?: string,
  signal?: AbortSignal
): Promise<RelayChatResult> {
  const res = await fetch(`${RELAY_HTTP_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, timelineContext, sessionId }),
    // Aborting closes the connection, which the relay treats as a signal to
    // kill the claude process it spawned — otherwise Stop would only hide a
    // turn that keeps running and keeps consuming quota.
    signal,
  });
  const data = await res.json();
  if (!res.ok || data.error) return { text: "", error: data.error || "Relay request failed" };
  return { text: data.text ?? "", sessionId: data.sessionId, isError: data.isError, usage: data.usage };
}

// Not Anthropic's real rate-limit percentage (see relay/server.mjs) — a
// running total against a soft budget you set yourself. Fetched on demand
// (e.g. on mount, or to refresh without waiting for the next chat turn).
export async function getRelayUsage(): Promise<RelayUsage | null> {
  try {
    const res = await fetch(`${RELAY_HTTP_URL}/usage`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface RelayToolResult {
  ok: boolean;
  message: string;
  imageDataUrls?: string[];
}

export type RelayToolCallHandler = (name: string, input: Record<string, unknown>) => Promise<RelayToolResult>;

// Opens the browser<->relay bridge — the relay's MCP server (a subprocess of
// `claude -p`) has no access to this tab's canvas/video/WASM APIs, so every
// tool call it receives gets forwarded here over WebSocket, executed with
// the SAME dispatchTool() the normal chat path uses, and the result sent
// back. Returns a cleanup function; safe to call even if the relay isn't
// actually running (the socket just fails to open, silently).
export function connectRelayBridge(onToolCall: RelayToolCallHandler): () => void {
  let closed = false;
  const ws = new WebSocket(RELAY_WS_URL);
  ws.onmessage = async (event) => {
    let msg: { type: string; id: string; name: string; input: Record<string, unknown> };
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type !== "tool_call") return;
    const result = await onToolCall(msg.name, msg.input).catch(
      (err): RelayToolResult => ({ ok: false, message: err instanceof Error ? err.message : "Tool call failed" })
    );
    if (!closed && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "tool_result", id: msg.id, result }));
    }
  };
  return () => {
    closed = true;
    ws.close();
  };
}
