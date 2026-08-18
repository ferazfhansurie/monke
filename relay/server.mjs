#!/usr/bin/env node
// Optional local relay for PERSONAL use only — see README.md. Routes YOUR
// OWN chat turns in MONKe through `claude -p` (your Claude Code subscription
// login) instead of the hosted Anthropic API MONKe's other customers use.
// Only ever run this yourself, on your own machine; never deploy it.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AGENT_TOOLS } from "../lib/agent-tools.ts";
import { SYSTEM_PROMPT } from "../lib/system-prompt.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MONKE_RELAY_PORT) || 8137;
const MCP_SERVER_PATH = join(__dirname, "mcp-server.mjs");
const USAGE_LOG_PATH = join(__dirname, ".usage-log.json");

// --- Usage tracking --------------------------------------------------------
// NOT Anthropic's actual 5hr/weekly rate-limit percentage — that's computed
// server-side against your real subscription quota and isn't derivable from
// anything the CLI reports locally. This is a running total of the
// `total_cost_usd` figure claude -p already returns per turn (dollar-
// equivalent value, an approximation of usage weight), tracked against a
// budget YOU set below, not Anthropic's own limit. Persisted to a local
// file so it survives a relay restart, unlike everything else in this file.
const WEEKLY_BUDGET_USD = 20;

let usageLog = [];
try {
  if (existsSync(USAGE_LOG_PATH)) usageLog = JSON.parse(readFileSync(USAGE_LOG_PATH, "utf8"));
} catch {
  usageLog = [];
}

function recordUsage(costUsd) {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return;
  usageLog.push({ ts: Date.now(), costUsd });
  // Keep the file from growing forever — a year of even heavy personal use
  // is nowhere near this many turns.
  if (usageLog.length > 20000) usageLog = usageLog.slice(-20000);
  try {
    writeFileSync(USAGE_LOG_PATH, JSON.stringify(usageLog));
  } catch (err) {
    console.error("Couldn't persist usage log:", err.message);
  }
}

function usageSummary() {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const sum = (sinceMs) => usageLog.filter((e) => e.ts >= now - sinceMs).reduce((acc, e) => acc + e.costUsd, 0);
  const weekCostUsd = sum(7 * DAY_MS);
  return {
    todayCostUsd: sum(DAY_MS),
    weekCostUsd,
    allTimeCostUsd: usageLog.reduce((acc, e) => acc + e.costUsd, 0),
    turnCount: usageLog.length,
    weeklyBudgetUsd: WEEKLY_BUDGET_USD,
    weeklyBudgetPct: Math.min(100, Math.round((weekCostUsd / WEEKLY_BUDGET_USD) * 100)),
  };
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
  };
}

function originAllowed(req) {
  const origin = req.headers.origin;
  // Non-browser tools (curl, the MCP subprocess's own internal fetch) send
  // no Origin header at all — allow that; reject only a browser request
  // from somewhere NOT in the allow-list.
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

function runClaude({ prompt, sessionId }) {
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

    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
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
    res.end(JSON.stringify(usageSummary()));
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
      const result = await runClaude({ prompt, sessionId: typeof sessionId === "string" ? sessionId : undefined });
      recordUsage(result.total_cost_usd);
      res.writeHead(200, { ...headers, "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          text: result.result ?? "",
          sessionId: result.session_id,
          isError: !!result.is_error,
          costUsd: result.total_cost_usd,
          usage: usageSummary(),
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
