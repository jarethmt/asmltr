# Discord connector

The Discord connector (`connectors/types/discord/index.js` + `voice.js`) is the richest asmltr
channel. It handles text chat (mention + autonomous participation), multi-agent group chats, an
`@mention`-driven command system, and an optional **voice mode** (join a voice channel, transcribe,
answer out loud). Everything below is per-instance config on the connector; the assistant's *brain*
is still the shared core.

---

## First-time setup: create the application, bot, and token

Before asmltr can run a Discord instance, you need a Discord **application** with a **bot** and its
**token**. This is a one-time job in the
[Discord Developer Portal](https://discord.com/developers/applications), and it comes before the
invite step below.

1. **New Application**, then name it. This name is the identity people see in Discord.
2. Open the **Bot** tab. Under **Token**, click **Reset Token** and copy it once (Discord shows it a
   single time). Store it where your `bot_token_bws_key` resolves: with the default key
   `discord_bot_token`, that means `DISCORD_BOT_TOKEN=<token>` in `.env`.
3. Enable the **Message Content** intent (next section). This is the step most setups miss.

### Enable the Message Content intent (required)

On the **Bot** tab, under **Privileged Gateway Intents**, turn **MESSAGE CONTENT INTENT** on & save.

The connector requests it (`GatewayIntentBits.MessageContent` in
`connectors/types/discord/index.js`), and Discord refuses the gateway connection for a privileged
intent the application hasn't enabled. Leave it off & the instance fails to start with
`Used disallowed intents` in its logs and restart-loops; a bot that does connect without it reads
**empty** message text, so every message looks blank & it silently never replies. This is the single
most common reason a fresh Discord bot looks dead. Turn it on, then start or restart the instance.

- **MESSAGE CONTENT INTENT** — **required.** Without it the bot reads no message text.
- **SERVER MEMBERS** & **PRESENCE** — not used by the connector; leave them off.

A bot in 100+ servers needs Discord to verify the application before this intent unlocks; a personal
or single-server bot toggles it freely.

### Direct messages need a shared server

A Discord bot can only DM a user who already shares a server with it. So `dm_allowed_user_id` takes
effect only once the bot & that user are both in a common server (a private one-person server is
enough). Invite the bot (next section) first, then open a DM with it.

---

## Adding / removing the bot from a server

**Adding the bot to a Discord server is a Discord OAuth authorization, not an asmltr config change.**
One bot token drives one Discord application, and that application serves *every* server it's a
member of. So you don't "configure a server" in asmltr — you invite the bot, and the running
connector sees the new guild over the gateway **instantly, with no restart**.

**The easy way (dashboard):** Integrations → the Discord instance card → **Servers**. The modal shows
the **invite URL** (copy or open it) and every server the bot is already in, each with a **Leave**
button. Open the invite as someone with **Manage Server** on the target, authorize, and the bot joins.

**By hand:** build the invite URL from the application (client) ID + a permission integer:

```
https://discord.com/api/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot%20applications.commands&permissions=<PERMS>
```

- **Application ID** — the bot's application/client ID (Discord Developer Portal → your app → General
  Information, or the numeric ID the dashboard's Servers modal shows).
- **Permissions** — asmltr's default `3525696` covers view/send/read-history/embed/attach/react/
  external-emoji plus voice connect + speak. Adjust in the Developer Portal's OAuth2 URL Generator if
  you want a narrower or wider set.
- **Scopes** — `bot` is required; `applications.commands` future-proofs slash commands.

The connector also exposes this over its control API (proxied by the manager):

```
GET  /instances/<id>/servers          # → { invite_url, application_id, servers: [{id,name,member_count}] }
POST /instances/<id>/servers { "leave": "<guildId>" }   # bot leaves that server
```

**Removing:** click **Leave** in the Servers modal, `POST …/servers {leave}`, or — from Discord —
Server Settings → Members → kick the bot. Leaving is immediate; the gateway drops the guild.

> Per-channel monitoring (which channels it actually listens in once it's in a server) is separate —
> see **Channel enable/disable** below.

---

## Message flow — when does it respond?

Every message runs through this gauntlet in `messageCreate` (first `return` wins). Understanding the
order explains all the behavior:

1. **Own message** → ignore (`author.id === bot`).
2. **Voice artifact** → ignore any message starting with `🗣️`/`🔊` (transcripts / spoken-reply mirrors
   that *any* agent posts for its own voice session — never conversation for another agent).
3. **Bot filter** → ignore messages from other bots **unless** the sender is in `allowed_bot_names`
   (or `engage-all-bots` mode is on). Humans always pass.
4. **Commands** (`handleControlCommands`) → if the message `@mentions` the bot (or a role it holds)
   and the text is a recognized command, run it and stop. See [Commands](#commands).
5. **Disabled channel** → if this channel is disabled (via `mute`, the TUI, or an allowlist default),
   ignore everything except the commands above. See [Channel enable/disable](#channel-enabledisable--control-what-it-listens-to).
6. **Voice-session suppression** → while it's in an active voice session in this guild, it answers
   by *voice* only; non-`@mention` text is dropped (prevents a doubled spoken + text reply).
7. **Directed at another agent** → if `ignore_other_mentions` (default on) and the message `@mentions`
   another user/bot **or leads with another agent's name** ("some-other-bot, …") and *not* the assistant → ignore.
   (Plain names aren't real Discord `@`-mentions, so both cases are checked.)
8. **Silenced** → if `silence`d, only respond to a direct `@mention`.
9. **Autonomous participation** (`shouldRespondTo`) → otherwise, respond if `@mentioned`, the message
   uses its name (lead/trail/mid), asks a question involving it, matches a relevant topic, or it's
   mid-thread. This is what lets it chime in on a passive name-drop.

Two more guards apply when it *does* generate a reply:

- **Self-gating** — the core prompt tells it, in a multi-agent room, to emit only the token
  `[[NO_REPLY]]` if a message isn't actually for it; the connector then drops the reply silently.
- **Dedup** — it never re-posts a reply verbatim-identical to one of its last ~6 in that channel
  (guards against rare replays in long resumed sessions).

---

## Commands

Commands are **`@mention`-driven** (universal — no hardcoded name). Address the bot directly
(`@Bot <command>`) **or** `@mention` a role the bot holds (so one ping commands *every* agent in that
role at once). Anything after the mention that isn't a recognized command is treated as a normal message.

| Command | Effect | Who |
|---|---|---|
| `silence` / `speak` | mention-only mode ↔ autonomous | owner |
| `mute` / `unmute` (aka `disable` / `enable`) | ignore **this channel** entirely ↔ resume (persisted) | owner |
| `engage-all-bots` / `disengage-all-bots` | hear **all** bots ↔ only the `allowed_bot_names` list (persisted) | owner |
| `join-voice` / `leave-voice` | join *your* voice channel + listen ↔ disconnect | owner |
| `status` | show silenced / bot-mode / this-channel state | anyone |
| `help` | list commands | anyone |

**Owner** = a principal with `bypass_moderation` (full trust) in *this bot's own trust store* —
resolved live via the core's `/trust/resolve`. So each agent knows its own owner; nobody else can
run the state-changing commands. State (`mute`, `engage-all-bots`) persists in
`connectors/manager/data/discord-<id>-settings.json`.

## Channel enable/disable — control what it listens to

By default the bot processes every text channel it can see in every server it's in. In a busy
server that's wasteful: each surfaced message that passes the gauntlet becomes a core turn (usage).
Two ways to scope it, both **per-channel and persisted**, both meaning *fully ignored — no relay to
core, no usage* (owner `@mention` commands still work in a disabled channel so you can re-enable it):

- **Blocklist (default):** `channels_default: true` — listen everywhere, disable the noisy ones.
- **Allowlist:** set `channels_default: false` in the instance config — ignore *every* channel except
  the ones you explicitly enable. Best when the bot sits in a big server but only a couple of
  channels matter.

**From the TUI/GUI (no restart):** in `asmltr` press **`c`** for the channels view — every channel
each connector can reach, grouped by instance, with its on/off state. `SPACE`/`ENTER` toggles the
selected channel, `d` flips that instance's default (blocklist ↔ allowlist), `r` reloads, `ESC` exits.

**Over HTTP:** the connector exposes `GET /channels` and `POST /channels {channel_id, enabled}` (or
`{channel_id, clear:true}` to drop an override back to default, or `{default_enabled}` to flip the
mode) on its `http_port`; the manager proxies these as `GET|POST /instances/<id>/channels` so the
TUI/dashboard can drive any connector uniformly. Changes take effect immediately — no reconnect.

---

## Reading Discord: servers, channels, history, search

The enable/disable endpoints above are the control plane. Asking Discord a question goes through the
same `/read` contract the mailbox uses, so the CLI and the agent share one transport:

```
asmltr discord guilds                       # servers the bot is in
asmltr discord channels -q shop             # channels whose name contains "shop"
asmltr discord channels --type voice        # text,announcement,thread,voice,forum,stage,media
asmltr discord history shop-floor -n 100    # by name, by alias, or by channel id
asmltr discord read shop-floor -n 100       # `read` is an alias for `history`, as in `mail read`
asmltr discord search "BigPAM" --guild Shop
```

Under it: `POST <manager>/read { channel: 'discord', op, ... }`, proxied to the connector's own
`POST /read`. `channel` selects the connector, so the Discord channel being read is `target`, the
same word `meta.outbound.target` already uses.

| op | arguments |
| --- | --- |
| `guilds` | `q` (fuzzy) |
| `channels` | `q` (fuzzy, matches name and topic), `guild` (fuzzy), `type`, `include_containers` |
| `history` | `target` (id, alias, or fuzzy name), `limit` (default 50, cap 500), `before`, `after`, `around` |
| `search` | `q` (message text), `target`, `guild`, `limit`, `scan` (per channel, default 200, cap 1000) |

`history` paginates, because one Discord fetch returns at most 100 messages.

### Finding a channel without knowing its exact name

`q` and `target` do not need the name as Discord stores it. Nobody types `🔧shop-floor`. Lookup
scores every candidate against its name, its `guild name` form, and its topic:

```
asmltr discord channels -q "floor shop"     # word order does not matter
asmltr discord channels -q "shpfloor"       # typos and missing separators
asmltr discord channels -q "nickel plating" # matches the TOPIC, not the name
asmltr discord guilds -q "pittsburg"        # server names too
asmltr discord history "radiator general"   # name the guild to pick between two #general
```

Each row carries `score` (0 to 1) and `matched_on` (`name`, `guild#name` or `topic`), and the CLI
prints both, so a weak hit is visibly a weak hit. A topic match is scored at a discount and can never
outrank a channel whose name actually says it.

Resolving a single `target` needs a winner that is both over the bar and clearly ahead of the
runner-up. Two channels called `#general` is an error listing both with their scores, because
choosing one silently reads the wrong room. Naming the guild breaks the tie.

**This is lexical matching, not embeddings.** "printer jam" will not find `#bigpam-z` unless one of
those words is in its name or topic. Set a channel topic and it becomes findable by what it is for.

`channel-aliases.json` still wins outright when the input is an alias, and a raw channel id skips
scoring entirely.

**`search` is a scan, not an index.** Discord's message search endpoint is user-only and closed to
bot tokens, so `search` walks recent history per channel and matches plain text, case-insensitively.
The response carries `scanned` and `truncated` for that reason: zero matches means "none in the last
`scan` messages of each channel", not "not said". Raise `--scan` to look further back.

**No `/regex/`.** A `/pattern/`-shaped query is refused with a 400 rather than compiled. A pattern
from a caller is a program running on the connector child process the manager spawned, and the scan
reaches up to 1000 messages in every channel the caller can read: `(a+)+$` against a few dozen
characters backtracks exponentially, wedges that process so every Discord session it serves stops,
and leaves core's proxied request hanging until it times out. No limit fixes that, because the
blow-up is exponential in the length of the text being matched and not in the pattern, which is six
characters long. It is refused rather than searched as literal text so a `/jam+ed/` query says why
instead of returning nothing. Regex search can come back on a linear-time engine; it is not coming
back on `new RegExp`.

### What it will not read by default

These are reads across channel boundaries, which is the hole [#132][132] describes. The gate itself
belongs in core, not here, so the ops ship three defaults instead:

- **DMs are excluded** from `channels`, `history` and `search`. Pass `--include-dms` to read one
  deliberately.
- **Operator-disabled channels are excluded.** A disabled channel already means *fully ignored* for
  ingest and reply, so reading one anyway would contradict that setting. `--include-disabled`
  overrides, and `asmltr discord channels` tells you how many rows it held back.
- **Channels the bot cannot view are omitted**, rather than listed and then failing on read.
- **Every op emits a `control` event** with the arguments (`action: discord-read`), never the message
  content. A crossing is auditable in the event stream while the real gate is still a design.

A name that matches two channels is an error listing both, not a pick, so `history general` in a
setup with two `#general` channels tells you to pass the id.

[132]: https://github.com/jarethmt/asmltr/issues/132

---

## Multi-agent group chats

Several agents can share a channel. Key knobs:

- **`allowed_bot_names`** — usernames of *other* agents this bot should hear (else all bots are
  ignored). Reciprocal: for A↔B, A must list B *and* B must list A.
- **`engage-all-bots`** command — skip the allowlist and hear every bot (relies on `[[NO_REPLY]]`
  self-gating + rate limits to stay sane). `disengage-all-bots` reverts.
- **`ignore_other_mentions`** (default true) — a message directed at a *specific other* agent
  (`@Other` or leading "Other, …") is dropped, so a single-agent question only wakes that agent.
- **Transcript-ignore** — agents skip each other's `🗣️`/`🔊` voice lines.
- **Rate limits** — `min_response_interval_ms` (default 10s between autonomous replies) and
  `max_responses_per_hour` (default 20/channel).

---

## Voice mode

Optional; needs **ffmpeg** and an OpenAI key (STT) + optionally ElevenLabs (TTS).

1. **`@Bot join-voice`** (while you're in a voice channel) → it joins, chimes, and starts listening.
2. **Listening** — Discord gives a separate audio stream per speaker (free diarization). Each
   utterance is captured (silence-gated + energy-gated to skip noise), transcribed via OpenAI
   (`gpt-4o-transcribe`, language-locked, name-biased prompt), and posted as `🗣️ name: …`.
3. **Addressing it** — say its name (lead **or** trail: "Assistant, …" / "…, Assistant"). It chimes ("heard
   you"), plays a soft **"working" drone** while the turn runs, then **speaks** the reply (ElevenLabs)
   and mirrors it as `🔊 Name: …`.
4. **Follow-ups** — after it answers, follow-ups need **no wake word** for `voice_followup_ms`
   (default 45s, extends each exchange). No chime on follow-ups, just the drone.
5. **Dismissal** — "that's enough, Assistant" / "we're good" / "go back to listening" exits answering mode
   back to **transcription-only** (it stays in the channel).
6. **`@Bot leave-voice`** (or say "leave voice") → disconnect.

Voice replies run through the core's redaction (public), so it won't speak secrets aloud.

---

## Configuration (`meta.configSchema`)

Discoverable live at `GET /types` on the manager. Fields:

| Field | Default | Purpose |
|---|---|---|
| `bot_token_bws_key` | — | secret key name for the bot token (**required**) |
| `dm_allowed_user_id` | `""` | Discord user id allowed to DM the bot |
| `allowed_bot_names` | `[]` | other agents' usernames to engage |
| `ignore_other_mentions` | `true` | drop messages directed at another specific agent |
| `presence_text` | `""` | activity/status text |
| `min_response_interval_ms` | `10000` | min ms between autonomous replies |
| `max_responses_per_hour` | `20` | cap per channel |
| `http_port` | `3016` | outbound `/send-message` + `/out` HTTP port |
| `data_dir` | manager/data | memory + settings storage |
| `voice_id` | (default voice) | ElevenLabs voice for spoken replies |
| `elevenlabs_key_name` | `elevenlabs_api_key` | secret key name for ElevenLabs |
| `tts_model` | `eleven_turbo_v2_5` | ElevenLabs model |
| `stt_language` | `en` | voice STT language (empty = auto) |
| `voice_followup_ms` | `45000` | no-wake-word follow-up window |

Secrets consumed at runtime (via the secret provider): the bot token, `openai_api_key` (voice STT),
and the ElevenLabs key.

---

## Memory & outbound

- **Memory** — hierarchical per-server/-channel history (last 200 msgs/channel + a 500-entry global
  timeline for cross-channel recall), persisted to `discord-<id>-memory.json`. Fed to the core as
  context; the *session* itself lives in the core (per-channel `conversation_key`).
- **Outbound** — declares `outbound` in `meta`, so the manager's `POST /send` can route messages out
  through it (used by admin alerts and any `/send` caller). Channel **aliases** map friendly names →
  channel ids via a gitignored `channel-aliases.json` (see `.example`).
