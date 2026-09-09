# MCP tools registry

<p class="asmltr-gradient" style="font-size:1.2rem;font-weight:800;margin-top:-0.4rem">Declare a tool once. Every engine gets it — Claude, Gemini, Codex, and Grok alike.</p>

[MCP](https://modelcontextprotocol.io/) (the Model Context Protocol) is the standard way to give an AI
agent extra tools — a fetch tool, a database tool, a company API, anything. The catch: each harness
(Claude Code, Gemini CLI, Codex CLI) configures MCP servers differently. asmltr hides that behind **one
registry**: you declare a server once, and asmltr provisions it into whichever engine runs a turn, in
that harness's own format.

!!! abstract "Two things this gives you"
    1. **Your own MCP servers, everywhere.** Add a server in one place; Claude, Gemini, and Codex all get it.
    2. **asmltr's own tools, everywhere.** A built-in **toolbelt** server exposes asmltr's cross-session
       tools to *every* engine — the same capability that used to be a Claude-only prompt cheatsheet.

## The built-in toolbelt

asmltr ships one MCP server of its own — **`asmltr-toolbelt`** — always on unless you disable it. It
turns the assistant's cross-session `asmltr` commands into real, structured tools any engine can call:

| Tool | What it does |
|------|--------------|
| `asmltr_sessions` | List the assistant's currently active sessions across every channel. |
| `asmltr_map` | Collision radar: active sessions grouped by git repo / working dir (from recent file activity), flagging repos with more than one session. Check before starting work. |
| `asmltr_who` | Which sessions recently touched a specific file or directory — a targeted collision check for one path. |
| `asmltr_send` | Deliver a message out through any connector (Discord, Telegram, email, …). |
| `asmltr_announce` | Post a non-coercive note other sessions see on their next turn. |
| `asmltr_uploads` | List recent files uploaded to the shared upload area. |

Under the hood it's a tiny, zero-dependency stdio MCP server (`mcp/toolbelt-server.js`) that wraps the
existing [`asmltr` CLI](cli.md) — so the CLI stays the single source of truth and the model sees clean,
plain-text output.

!!! example "It really works end-to-end"
    Ask a running assistant *"use your tools to list my active sessions and give me the count"* and —
    on any engine — it calls `asmltr_sessions` through MCP and answers from live data.

## Add your own server

**Settings → Engines → MCP tools → Add a server.** Give it a name, then either:

- a **command** + args for a stdio server (e.g. `npx` `-y @modelcontextprotocol/server-fetch`), or
- an **http URL** for a remote MCP server.

Or via the API:

```bash
# a stdio MCP server
curl -X POST 127.0.0.1:3023/v2/mcp -H 'content-type: application/json' \
  -d '{"name":"fetch","command":"npx","args":["-y","@modelcontextprotocol/server-fetch"]}'

# a remote http MCP server
curl -X POST 127.0.0.1:3023/v2/mcp -H 'content-type: application/json' \
  -d '{"name":"my-api","url":"https://mcp.example.com"}'
```

Toggle a server off without deleting it, or remove it entirely, from the same panel
(`POST /v2/mcp/:name/toggle`, `DELETE /v2/mcp/:name`). The built-in toolbelt can be disabled but not
removed.

## How provisioning works per harness

You declare a server once; asmltr translates it into each harness's native shape at launch:

| Engine | How the registry reaches it |
|--------|------------------------------|
| **Claude** | Passed as the Agent SDK's `mcpServers` option when the turn runs. |
| **Codex** | Injected as per-launch `-c mcp_servers.<name>.{command,args,env\|url}` flags. |
| **Gemini** | Reconciled into Gemini's own config via `gemini mcp add` (once per process; re-synced when the registry changes). |
| **Grok** | Reconciled via `grok mcp add` (once per process; stdio servers; re-synced when the registry changes). |

The registry lives in `~/.asmltr/mcp.json` (per-install, gitignored — it can carry env secrets). A
`mcp.example.json` ships as a template.

## Config shape

```json
{
  "servers": {
    "fetch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"],
      "env": {}
    },
    "my-api": { "type": "http", "url": "https://mcp.example.com" }
  }
}
```

## See also

- **[Reasoning engines](engines.md)** — picking and configuring the engines this registry feeds.
- **[MCP connector](connectors/mcp.md)** — the *other* direction: exposing asmltr itself as an MCP server
  to external clients (Claude Desktop, etc.).
