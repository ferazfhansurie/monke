#!/usr/bin/env node
// Optional local relay for PERSONAL use only — see README.md. Routes YOUR
// OWN chat turns in MONKe through `claude -p` (your Claude Code subscription
// login) instead of the hosted Anthropic API MONKe's other customers use.
// Only ever run this yourself, on your own machine; never deploy it.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AGENT_TOOLS } from "../lib/agent-tools.ts";
import { SYSTEM_PROMPT } from "../lib/system-prompt.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MONKE_RELAY_PORT) || 8137;
const MCP_SERVER_PATH = join(__dirname, "mcp-server.mjs");

// --- Usage --------------------------------------------------------------
// Real subscription usage, straight from Claude Code's own `/usage` command
// — the same numbers its VS Code panel shows. Deliberately NOT the earlier
// approach of reading the OAuth token out of the Keychain and calling
// undocumented endpoints with a spoofed client User-Agent; this is the
// documented interface, so it can't break on us or misrepresent the client.
//
// Each call costs a little quota, so it's cached. Chat turns invalidate the
// cache (that's when usage actually moves), and the TTL is only a backstop.
const USAGE_TTL_MS = 5 * 60 * 1000;
let usageCache = { at: 0, data: null };

function parseUsage(text) {
  const session = text.match(/Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^(\n]+))?/i);
  const week = text.match(/Current week[^:]*:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^(\n]+))?/i);
  if (!session && !week) return null;
  return {
    sessionPct: session ? Number(session[1]) : null,
    sessionResets: session?.[2]?.trim() ?? null,
    weekPct: week ? Number(week[1]) : null,
    weekResets: week?.[2]?.trim() ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

function fetchUsage() {
  return new Promise((resolve) => {
    // Minimal invocation: no MCP, no system prompt, no tools — this is a
    // status read, and anything extra would cost more quota than it reports.
    const child = spawn("claude", ["-p", "/usage", "--output-format", "json"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out.trim().split("\n").pop());
        resolve(parseUsage(parsed.result ?? ""));
      } catch {
        resolve(null);
      }
    });
  });
}

async function usageSummary({ force = false } = {}) {
  const fresh = Date.now() - usageCache.at < USAGE_TTL_MS;
  if (!force && fresh && usageCache.data) return usageCache.data;
  const data = await fetchUsage();
  // Keep serving the last good numbers if a refresh fails — a transient
  // CLI hiccup shouldn't blank the meter.
  if (data) usageCache = { at: Date.now(), data };
  return usageCache.data;
}

// Only these origins may talk to the relay — CORS headers alone only stop
// compliant browsers from READING the response, not from sending the
// request in the first place, so this is checked server-side on every
// request too (basic protection against another open tab's page trying to
// poke a localhost service, a known class of attack against local dev
// servers/tools).
const ALLOWED_ORIGINS = new Set(["http://localhost:3000", "https://monk-editor.vercel.app"]);

function corsHeaders(origin) {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // Chrome's Private Network Access rules gate a public HTTPS page
    // reaching the loopback address space; this is the documented opt-in.
    "Access-Control-Allow-Private-Network": "true",
  };
}

function originAllowed(req) {
  const origin = req.headers.origin;
  // Non-browser callers (curl, the MCP subprocess's own fetch) send no
  // Origin at all — allow those; reject only a browser request from an
  // origin that isn't allow-listed.
  return !origin || ALLOWED_ORIGINS.has(origin);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

// --- Browser tool bridge -------------------------------------------------
// One browser tab connects at a time (personal, single-user tool) — a new
// connection replaces the old one rather than trying to support multiple.
let browserSocket = null;
const pendingToolCalls = new Map(); // id -> { resolve, reject, timeout }
const TOOL_TIMEOUT_MS = 90000;

function dispatchToolToBrowser(name, input) {
  return new Promise((resolve, reject) => {
    if (!browserSocket || browserSocket.readyState !== 1) {
      reject(new Error("No MONKe tab is connected to the relay right now — open MONKe and make sure it shows the relay as connected."));
      return;
    }
    const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timeout = setTimeout(() => {
      pendingToolCalls.delete(id);
      reject(new Error(`${name} timed out waiting for the browser tab to respond.`));
    }, TOOL_TIMEOUT_MS);
    pendingToolCalls.set(id, { resolve, reject, timeout });
    browserSocket.send(JSON.stringify({ type: "tool_call", id, name, input }));
  });
}

// --- Claude Code CLI invocation ------------------------------------------
const ALLOWED_TOOLS = AGENT_TOOLS.map((t) => `mcp__monke__${t.name}`).join(",");

function runClaude({ prompt, sessionId, onChild }) {
  return new Promise((resolve, reject) => {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        monke: { command: "node", args: [MCP_SERVER_PATH, String(PORT)] },
      },
    });
    const args = [
      "-p",
      prompt,
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      ALLOWED_TOOLS,
      "--output-format",
      "json",
    ];
    if (sessionId) {
      args.push("--resume", sessionId);
    } else {
      args.push("--append-system-prompt", SYSTEM_PROMPT);
    }

    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    onChild?.(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => reject(new Error(`Couldn't launch the claude CLI: ${err.message}. Is it installed and on PATH?`)));
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim().split("\n").pop());
        resolve(parsed);
      } catch {
        reject(new Error(`Couldn't parse claude's output: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

// --- HTTP server -----------------------------------------------------------
const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  if (!originAllowed(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Origin not allowed" }));
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, connected: !!browserSocket }));
    return;
  }

  if (req.method === "GET" && req.url === "/usage") {
    res.writeHead(200, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify(await usageSummary()));
    return;
  }

  if (req.method === "POST" && req.url === "/internal/dispatch-tool") {
    try {
      const { name, input } = await readJsonBody(req);
      const result = await dispatchToolToBrowser(name, input);
      res.writeHead(200, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(200, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/chat") {
    try {
      const { message, timelineContext, sessionId } = await readJsonBody(req);
      if (typeof message !== "string" || !message.trim()) {
        res.writeHead(400, { ...headers, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "message is required" }));
        return;
      }
      const prompt = typeof timelineContext === "string" && timelineContext.trim() ? `${timelineContext}\n\n${message}` : message;
      // Stopping in the browser aborts the fetch, which closes this
      // request. Without killing the child, `claude` would keep running to
      // completion and keep consuming subscription quota for a turn nobody
      // is waiting for any more.
      let child = null;
      let aborted = false;
      // res, not req: req's "close" fires once the request BODY has been
      // read, which happens immediately — it does not mean the client went
      // away. res "close" is the one that fires on a premature disconnect.
      res.on("close", () => {
        if (!res.writableEnded) {
          aborted = true;
          if (child?.pid) {
            // Negative pid signals the whole process group: `claude` spawns
            // its own children, and killing only the direct child would
            // leave those running.
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              child.kill("SIGTERM");
            }
          }
        }
      });
      const result = await runClaude({
        prompt,
        sessionId: typeof sessionId === "string" ? sessionId : undefined,
        onChild: (c) => (child = c),
      });
      if (aborted) return;
      const text = result.result ?? "";
      // `-p --output-format json` only ever returns final text — real tool
      // calls happen out-of-band as tool_use blocks and never appear as
      // literal text in a working turn. --mcp-config loading is async and
      // non-blocking (confirmed in the CLI's own debug log), so if the MCP
      // connection hasn't settled by the time generation starts, the model
      // has no real tools yet — but the system prompt still tells it it's
      // an editing agent with tools, so it free-associates a plausible
      // tool-call transcript AND a confident fabricated success message
      // instead of saying "no tools available". Caught this producing a
      // fake "cutout applied" response that left the raw clip untouched
      // while claiming success. A literal "<function_calls>"/"<invoke" in
      // the text is an unambiguous signal the turn never touched the
      // timeline, however convincing the prose reads.
      if (/<function_calls>|<invoke\s+name=/i.test(text)) {
        res.writeHead(200, { ...headers, "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            text: "That didn't actually reach the timeline — the editing tools weren't ready in time this turn, so nothing changed. Please try again.",
            sessionId: result.session_id,
            isError: true,
            costUsd: result.total_cost_usd,
            usage: await usageSummary({ force: true }),
          })
        );
        return;
      }
      res.writeHead(200, { ...headers, "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          text,
          sessionId: result.session_id,
          isError: !!result.is_error,
          costUsd: result.total_cost_usd,
          usage: await usageSummary({ force: true }),
        })
      );
    } catch (err) {
      res.writeHead(200, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  res.writeHead(404, headers);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/bridge" });
wss.on("connection", (ws, req) => {
  if (!originAllowed(req)) {
    ws.close(1008, "Origin not allowed");
    return;
  }
  browserSocket = ws;
  console.log("MONKe tab connected.");
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "tool_result") {
        const pending = pendingToolCalls.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingToolCalls.delete(msg.id);
          pending.resolve(msg.result);
        }
      }
    } catch {
      // ignore malformed frames
    }
  });
  ws.on("close", () => {
    if (browserSocket === ws) browserSocket = null;
    console.log("MONKe tab disconnected.");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`MONKe relay listening on http://127.0.0.1:${PORT} (personal use only — see README.md)`);
});
