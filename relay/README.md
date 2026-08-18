# MONKe personal relay

Optional, personal use only. Routes **your own** MONKe chat turns through your
own Claude Code subscription login (`claude -p`, reusing whatever session
`claude login` already set up on this Mac) instead of MONKe's hosted Anthropic
API key. Every other MONKe account is unaffected — this only activates for
the admin account (`lib/admin.ts`), and only while this relay is actually
running.

**Why this exists**: so testing/using MONKe yourself doesn't burn the hosted
API key's metered billing that your actual paying customers' usage is priced
against.

**Why it's not built into the deployed app**: MONKe's backend runs on Vercel,
which has no access to your laptop's Claude Code login. This has to run
locally, on your own machine, as a separate process you start yourself.

## What it does, concretely

- Spawns `claude -p` per chat turn, with MONKe's tools (`timeline_probe_clip`,
  `timeline_transcribe_clip`, `generate_stock_clip`, etc.) exposed to it via
  an MCP server.
- Since those tools need real browser APIs (canvas, `<video>`, WASM models)
  that a local Node process can't reach, tool calls are bridged over a
  WebSocket back to your actual MONKe browser tab, executed there with the
  exact same `dispatchTool()` the hosted path uses, and the result relayed
  back.
- Conversation continuity uses `claude -p --resume <session-id>` — MONKe's
  own "New chat" / history-switch actions reset this, same as they reset the
  hosted conversation.

## Running it

```
cd relay
npm install
npm start
```

Then run MONKe itself locally too, and use it at **http://localhost:3000**:

```
npm run dev        # from the repo root, in a second terminal
```

### Why localhost and not the deployed site

**The relay does not work from https://monk-editor.vercel.app.** Chrome
blocks a public HTTPS page from reaching the loopback address space —
verified, the fetch fails with:

> Access to fetch at 'http://localhost:8137/health' from origin
> 'https://monk-editor.vercel.app' has been blocked by CORS policy:
> Permission was denied for this request to access the `loopback` address
> space.

This is Private Network Access / Local Network Access, a browser security
rule, not a bug in the relay — a random website should not be able to probe
services on your machine. The server does send
`Access-Control-Allow-Private-Network: true`, which is the documented
opt-in, but current Chrome additionally gates loopback behind a permission
that a public origin doesn't get.

Serving MONKe from localhost puts the page and the relay in the same
address space, so the rule doesn't apply. Verified working that way.

Leave both running in terminals while you use MONKe. The chat panel shows a
small **"Personal relay"** badge when it detects the relay and is using it —
if that badge isn't there, MONKe is using the normal hosted API, either
because you're not signed in as the admin account or the relay isn't running.

Requires the `claude` CLI installed and logged in (`claude login`) on this
machine — it reads whatever OAuth session that already set up; this file
doesn't handle auth itself.

## Security notes

- Listens on `127.0.0.1` only — never exposed off this machine.
- Only accepts requests whose `Origin` is MONKe's actual known origins (see
  `ALLOWED_ORIGINS` in `server.mjs`) — checked server-side, not just via CORS
  headers, since CORS alone only stops compliant browsers from *reading* a
  response, not from sending the request.
- Never deploy this anywhere. It's a personal, single-machine tool.
