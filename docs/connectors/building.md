# Building a connector

<p class="asmltr-gradient" style="font-size:1.2rem;font-weight:800;margin-top:-0.4rem">A connector is thin I/O — it knows how ONE channel works and nothing else. Everything shared (identity, memory, trust, moderation, prompt-building, execution, redaction) lives in the core.</p>

To add a new channel, you write **one file** that emits a normalized *envelope* and renders a reply. This
page is the contract.

## The shape

A connector type is a directory under `connectors/types/<type>/` whose `index.js` exports two things:

```js
module.exports = { meta, start };
```

- **`meta`** — static description the manager reads via `require()` (before spawning anything).
- **`start(ctx)`** — an async function that boots the connection and returns `{ stop, health }`.

Each *enabled instance* of your type runs as its **own OS process** (crashes don't cascade), supervised
by the connector manager.

### `meta`

```js
const meta = {
  type: 'mychannel',              // unique id, matches the directory name
  displayName: 'My Channel',
  supportsMultiple: true,         // can the user run >1 instance of this type?
  capabilities: {                 // what the surface can render (drives redaction/formatting)
    max_message_chars: 4000,
    supports_markdown: true,
  },
  credentialKeys: ['bot_token_bws_key'],   // config fields that name a vault secret
  configSchema: {                 // JSON Schema — the manager validates config against it
    type: 'object',
    required: ['bot_token_bws_key'],
    properties: {
      bot_token_bws_key: { type: 'string', title: 'Bot token secret key' },
      poll_interval_ms:  { type: 'integer', title: 'Poll interval (ms)', default: 20000 },
    },
  },
  // optional: outbound: { kinds: ['text'], target: { required: true, label: 'chat id' } }
};
```

### `start(ctx)`

```js
async function start(ctx) {
  const cfg = ctx.config;
  const token = await ctx.secrets.get(cfg.bot_token_bws_key); // resolve secrets from the vault — never hardcode

  // … connect to your channel, and on each inbound message: build an envelope, call the core,
  //    render the reply back to the channel (see below) …

  return {
    async stop() { /* clean shutdown: close sockets, clear timers */ },
    health() { return { connected: true }; },   // shown on the dashboard
  };
}
```

## The `ctx` object

`start(ctx)` receives everything a connector needs. Never reach around it:

| `ctx.…` | What it does |
|---|---|
| `instanceId` / `instanceName` / `type` | who this instance is |
| `config` | this instance's config (already validated against `meta.configSchema`) |
| `core.handle(envelope)` → `actions[]` | run a turn through the full pipeline; returns actions to render |
| `core.handleStream(envelope, handlers)` | streaming variant (`onDelta`/`onSegment`/`onTool`/`onThinking`) for live channels |
| `core.resolve(envelope)` | resolve sender → `{ trust_tier, display_name, bypass_moderation, … }` without running a turn |
| `secrets.get(key)` | resolve a secret from the vault (env → file → vault → command) |
| `uploads.save({...})` | put a received file on the shared cross-channel upload surface |
| `emit(partialEvent)` | send a telemetry event to the collector (shows on the dashboard) |
| `log(...args)` | stdout, prefixed with `[type:name]` (scraped into the instance's log ring) |
| **`heartbeat()`** | **signal liveness from your active I/O path — see below** |
| `signal` | an `AbortSignal` fired on shutdown; listen to stop gracefully |

## Inbound → envelope → reply

The one interface to the core is the **envelope**. Build one per inbound message and hand it to
`ctx.core.handle()`:

```js
const actions = await ctx.core.handle({
  channel: 'mychannel',
  conversation_key: `mychannel:${ctx.instanceId}:user:${userId}`, // STABLE PK → same key resumes the session
  message_id: String(msg.id),
  sender: { raw_id: userId, raw_username: displayName },
  content: { text: msg.text, attachments: [] },
  delivery: 'sync',                 // or 'async' for observe-only ingestion
  capabilities: meta.capabilities,
  public: false,                    // true on broadcast surfaces → stricter redaction
});

for (const a of actions) {
  if (a.type === 'reply') await sendToMyChannel(userId, a.text);
}
```

`conversation_key` is the primary key for the session — make it **deterministic** (same user/room → same
key) so the SDK session resumes instead of starting fresh. The core owns identity, trust, moderation,
prompt-building, execution, and secret redaction; your connector never does any of that.

## Liveness: call `ctx.heartbeat()`

The manager supervises your instance by **process liveness** — if the pid is alive, it reports `running`.
That is not enough: an I/O loop can die (a dropped poll loop, a wedged socket, an IMAP IDLE that half-opens
without emitting `close`) while the process stays up. The instance then reports `running` but relays
nothing — *deaf but running*.

So if your connector has an **active I/O loop**, call `ctx.heartbeat()` from the path that only runs when
I/O actually happened — a completed poll cycle, an inbound message, a gateway confirmed still Ready:

```js
// after a poll cycle completes, or on each inbound event:
ctx.heartbeat();
```

The supervisor records the last heartbeat and, past a threshold (`ASMLTR_HEARTBEAT_STALE_MS`, default
120000), surfaces the instance on `GET /instances` as `healthy:false / heartbeat:stale` **without killing
it** — so a silent stall becomes visible instead of a mystery. An instance that has never heartbeat reads
`heartbeat:unknown` (a just-spawned connector isn't flagged before its loop has run).

!!! warning "Two rules that keep this honest"
    1. **Heartbeat from real I/O, not a bare timer.** A `setInterval(() => ctx.heartbeat())` that ticks
       regardless of whether the loop is alive defeats the purpose. Emit it *after* work actually
       happened (a poll returned, a probe round-tripped, an event arrived).
    2. **Time-box every network call.** An `await fetch(...)` or IMAP command with no timeout can hang
       forever, and enough hung calls exhaust the connection pool → deaf. Use `AbortSignal.timeout(...)`
       (HTTP) or a NOOP-with-timeout probe (IMAP). A stall should become a *catchable error*, not an
       infinite wait.

**Reference implementations:** `telegram` (heartbeat when the poll cursor advances), `discord` (gateway
`Ready` + inbound messages), `github` (each completed poll cycle + `AbortSignal.timeout` on every request),
`email` (a periodic time-boxed IMAP NOOP that also forces a reconnect when the link is dead). Passive
inbound HTTP servers (`mcp`, `openai`) have no silent poll loop and are intentionally exempt.

## Registering an instance

Drop your type at `connectors/types/<type>/index.js`, then create an instance via the manager (or the
dashboard's Connectors view):

```bash
curl -s -X POST 127.0.0.1:3024/instances -H 'Content-Type: application/json' -d '{
  "type":"mychannel","name":"my-instance","enabled":true,
  "config": { "bot_token_bws_key":"mychannel_token" }
}'
```

The config is validated against your `meta.configSchema`, persisted, and the manager spawns (and
supervises) the instance. Reload one instance without restarting the manager:
`POST /instances/<id>/restart`; tail it via `GET /instances/<id>/logs`.

## See also

- [Connectors overview](index.md) — the channels that ship today.
- [Architecture](../architecture.md) — where the connector sits in the pipeline.
