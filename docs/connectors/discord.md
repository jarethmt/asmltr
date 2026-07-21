# Discord connector

The Discord connector (`connectors/types/discord/index.js` + `voice.js`) is the richest asmltr
channel. It handles text chat (mention + autonomous participation), multi-agent group chats, an
`@mention`-driven command system, and an optional **voice mode** (join a voice channel, transcribe,
answer out loud). Everything below is per-instance config on the connector; the assistant's *brain*
is still the shared core.

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
