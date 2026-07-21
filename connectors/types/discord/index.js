'use strict';
/**
 * asmltr connector type: DISCORD — full-feature Discord adapter.
 *
 * All Discord-specific behavior stays HERE (the plugin): hierarchical memory,
 * autonomous-participation logic, control commands, code-block reformat +
 * chunking, and the /send-message HTTP endpoint (message-discord depends on it).
 * The LLM turn goes through asmltr-core: the rich Discord context + server-aware
 * authorization rides as `system_prompt_extra`; content.text is the clean user
 * message (so moderation + identity work correctly). Per-guild continuity comes
 * from the core's session resume (conversation_key), replacing the old per-server
 * session-ids file.
 *
 * conversation_key = discord:<instanceId>:guild:<guildId>  (DMs: :dm:<userId>)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Partials, ActivityType, AttachmentBuilder, Status } = require('discord.js');
// THE shared asmltr speech layer — same TTS/STT used by the dashboard + core /v2/speak (DRY).
const sharedTts = require('../../../shared/speech/tts');
const sharedStt = require('../../../shared/speech/stt');

// Assistant identity — the display name AND the spoken wake word for voice.
const NAME = process.env.ASSISTANT_NAME || 'Assistant';
const WAKE = NAME.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // regex-escaped
// Self-gating sentinel: in a multi-agent channel the model emits ONLY this token when a
// message isn't meant for it, and the connector drops the reply instead of posting it.
const NO_REPLY = '[[NO_REPLY]]';
// The model sometimes PARAPHRASES the sentinel ("No response requested.", "No reply needed",
// "[no response]") instead of emitting the exact token — those must be dropped too, or the
// paraphrase gets posted as a message. The length guard keeps a genuine reply that merely
// mentions the phrase from being swallowed: only a short, self-contained refusal counts as silence.
function isSilence(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (t.toUpperCase().includes(NO_REPLY.toUpperCase())) return true;
  const s = t.replace(/^[[(*\s]+|[\])*.!\s]+$/g, '').toLowerCase();
  return s.length <= 40 && /^(no\s+(response|reply|comment)|n\/?a|silent)(\s+(requested|needed|required|necessary|expected|warranted|here|for me))?$/.test(s);
}
// Control commands that change the bot's behavior — restricted to the bot's owner.
const OWNER_ONLY_CMDS = new Set([
  'silence', 'be quiet', 'quiet', 'shush', 'speak', 'unsilence', 'wake up', 'resume',
  'mute', 'mute here', 'mute this channel', 'ignore this channel', 'disable', 'disable here',
  'unmute', 'unmute here', 'listen here', 'unmute this channel', 'enable', 'enable here',
  'engage-all-bots', 'engage all bots', 'engage all', 'disengage-all-bots', 'disengage all bots', 'disengage all',
  'drone-on', 'drone on', 'drone-off', 'drone off',
  'transcript-on', 'transcript on', 'transcript-off', 'transcript off',
  'join-voice', 'join voice', 'join vc', 'join the voice', 'leave-voice', 'leave voice', 'leave vc', 'leave the voice',
  'update-asmltr', 'update asmltr', 'self-update', 'update yourself',
]);

const meta = {
  type: 'discord',
  displayName: 'Discord',
  supportsMultiple: true,
  capabilities: { max_message_chars: 2000, supports_markdown: true, supports_code_blocks: false, supports_attachments_out: true },
  credentialKeys: ['bot_token_bws_key'],
  // How the Access page presents identifiers for this surface (trust framework).
  identifierFormats: [{ surface: 'discord', label: 'Discord User ID', placeholder: '000000000000000000', pattern: '^\\d+$' }],
  outbound: { kinds: ['text', 'photo', 'file'], target: { required: true, label: 'Channel id or alias (e.g. TD-TSD-main)' } },
  // Per-unit monitoring on/off: the assistant sits in many Discord channels and decides when to
  // chime in; each can be individually muted via the connector's /channels endpoint (no restart).
  // The dashboard reads this to know a session is mutable (matching a channel_id in the roster).
  mutable: { scope: 'channel', unit: 'channel', label: 'monitored channel', endpoint: 'channels' },
  configSchema: {
    type: 'object',
    required: ['bot_token_bws_key'],
    properties: {
      bot_token_bws_key: { type: 'string', title: 'Bot token (Bitwarden secret key)' },
      http_port: { type: 'integer', title: 'Send-message HTTP port', default: 3016 },
      dm_allowed_user_id: { type: 'string', title: 'Allowed DM user id', default: '' },
      min_response_interval_ms: { type: 'integer', title: 'Min ms between autonomous responses', default: 10000 },
      reply_debounce_ms: { type: 'integer', title: 'Reply debounce: wait this long for the channel to go QUIET before replying, so a multi-block message (or another agent mid-thought) fully lands first — prevents replying to a partial. Resets on each new message. 0 = reply immediately.', default: 3000 },
      max_responses_per_hour: { type: 'integer', title: 'Max autonomous responses/hour/channel', default: 20 },
      data_dir: { type: 'string', title: 'Memory data dir', default: '' },
      voice_id: { type: 'string', title: 'ElevenLabs voice id (spoken replies)', default: '' },
      tts_model: { type: 'string', title: 'ElevenLabs TTS model', default: 'eleven_turbo_v2_5' },
      allowed_bot_names: { type: 'array', title: 'Bot usernames to engage (else all bots ignored)', items: { type: 'string' }, default: [] },
      presence_text: { type: 'string', title: 'Presence/activity text', default: '' },
      elevenlabs_key_name: { type: 'string', title: 'Secret key name for ElevenLabs (voice)', default: 'elevenlabs_api_key' },
      stt_language: { type: 'string', title: 'Voice STT language (ISO code; empty = auto-detect)', default: 'en' },
      voice_followup_ms: { type: 'integer', title: 'Voice follow-up window (ms) after being addressed, during which follow-ups need no wake word. 0 = STRICT: only respond when directly addressed by name (recommended for meetings).', default: 0 },
      voice_drone: { type: 'boolean', title: 'Voice: play a soft ambient drone while processing a spoken reply', default: true },
      voice_post_transcript: { type: 'boolean', title: 'Voice: post the live transcript (🗣️ lines) into the text channel as people speak (off = no per-utterance flood)', default: true },
      voice_transcript_file: { type: 'boolean', title: 'Voice: upload a full transcript .txt to the origin channel when leaving the voice channel', default: true },
      stream_steps: { type: 'boolean', title: 'Post intermediary narration steps to the thread live as they land (only when directly addressed)', default: true },
      stream_tools: { type: 'boolean', title: 'Also post a subdued line for each tool call while streaming steps', default: false },
      ignore_other_mentions: { type: 'boolean', title: 'Do not REPLY to messages @-directed at other specific users/bots (still ingested for awareness)', default: true },
      ingest_unaddressed: { type: 'boolean', title: 'Ingest EVERY message in enabled channels into context (stay current on the whole conversation), replying only when addressed. False = only ingest what you might reply to.', default: true },
      channels_default: { type: 'boolean', title: 'Listen in channels by default (false = allowlist: ignore every channel except ones you enable)', default: true },
    },
  },
  // Interactive settings panels this connector exposes beyond plain config — the TUI/GUI
  // renders each generically (a connector adds a panel by declaring it here + serving its
  // HTTP endpoint). `kind` selects the client-side renderer; `endpoint` is proxied by the
  // manager as /instances/<id>/<endpoint>. Channel toggles are LIVE (no restart).
  panels: [
    { id: 'channels', title: 'Channels — which channels I listen to', kind: 'channels', endpoint: 'channels' },
  ],
};

const STOP_WORDS = new Set(['the','a','an','and','or','but','is','are','was','were','in','on','at','to','for','of','with','by','from','as','that','this','it','be','have','has','had','do','does','did','will','would','can','could','should','may','might']);
const RELEVANT_TOPICS = ['consciousness','ai','artificial intelligence','machine learning','docker','traefik','architecture','obsidian','note taking','knowledge management','autonomous','autonomy','bot','discord'];

async function start(ctx) {
  const cfg = ctx.config;
  // Bots are ignored unless their username matches the allowlist — OR engage-all-bots
  // mode is on (a runtime toggle for multi-agent group chats; see the mention commands).
  const allowedBotNames = (cfg.allowed_bot_names || []).map((s) => String(s).toLowerCase());
  const isAllowedBot = (u) => !!u && (engageAllBots || allowedBotNames.some((n) => u.toLowerCase().includes(n)));
  const token = (await ctx.secrets.get(cfg.bot_token_bws_key)) || cfg.bot_token;
  if (!token) throw new Error(`no bot token (bws key '${cfg.bot_token_bws_key}')`);
  const dmUser = cfg.dm_allowed_user_id || '';
  const ignoreOtherMentions = cfg.ignore_other_mentions !== false; // don't REPLY to msgs @-directed at OTHER users/bots (still ingested)
  const ingestUnaddressed = cfg.ingest_unaddressed !== false;      // ingest ambient (non-addressed) messages too, for full awareness
  const minInterval = cfg.min_response_interval_ms || 10000;
  const maxPerHour = cfg.max_responses_per_hour || 20;
  const replyDebounceMs = cfg.reply_debounce_ms != null ? cfg.reply_debounce_ms : 3000;
  const dataDir = cfg.data_dir || path.join(__dirname, '..', '..', 'manager', 'data');
  const memoryFile = path.join(dataDir, `discord-${ctx.instanceId}-memory.json`);

  // channel aliases for unified outbound (TD-TSD-main → channel id)
  let aliases = {};
  try { aliases = JSON.parse(fs.readFileSync(cfg.aliases_file || path.join(__dirname, 'channel-aliases.json'), 'utf8')).aliases || {}; } catch (_) {}
  const resolveChannel = (t) => aliases[t] || t;

  // --- state ---
  let memory = { servers: {}, globalTimeline: [] };
  const processing = new Map();
  const pendingReply = new Map(); // cid -> { timer, message, forced } — the reply-debounce quiet-window
  let silenced = false;
  let lastResponseTime = 0;
  const responseCount = new Map();
  const recentReplies = new Map(); // cid -> last few reply texts (dedup verbatim repeats)
  // persisted per-instance settings: per-channel enable/disable + engage-all-bots toggle.
  // channelStates holds EXPLICIT per-channel overrides (cid -> bool); channelsDefault decides
  // any channel without an override. default=true → "listen everywhere except disabled" (blocklist);
  // set channels_default:false in config → "ignore everywhere except enabled" (allowlist), for
  // bots sitting in big servers where only a couple of channels matter. A disabled channel is
  // fully ignored — no relay to core, no usage (mention-commands still work so you can re-enable).
  const settingsFile = path.join(dataDir, `discord-${ctx.instanceId}-settings.json`);
  const channelStates = new Map(); // channel_id -> boolean (explicit override)
  let channelsDefault = cfg.channels_default !== false; // unlisted channels: enabled unless config says otherwise
  let engageAllBots = false;
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    (s.mutedChannels || []).forEach((c) => channelStates.set(String(c), false)); // migrate legacy mutes
    if (s.channels && typeof s.channels === 'object') for (const [c, on] of Object.entries(s.channels)) channelStates.set(String(c), !!on);
    if (typeof s.channelsDefault === 'boolean') channelsDefault = s.channelsDefault;
    engageAllBots = !!s.engageAllBots;
  } catch (_) {}
  function channelEnabled(cid) { return channelStates.has(String(cid)) ? channelStates.get(String(cid)) : channelsDefault; }
  function saveSettings() {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify({ channels: Object.fromEntries(channelStates), channelsDefault, engageAllBots })); }
    catch (e) { ctx.log('settings persist failed: ' + e.message); }
  }

  // --- memory load/persist (hierarchical; Sets serialized as arrays) ---
  try {
    const loaded = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
    if (!Array.isArray(loaded)) {
      memory = loaded;
      for (const s in memory.servers) for (const c in memory.servers[s].channels)
        memory.servers[s].channels[c].participants = new Set(memory.servers[s].channels[c].participants);
    }
  } catch (_) {}
  function persistMemory() {
    const out = { servers: {}, globalTimeline: memory.globalTimeline };
    for (const s in memory.servers) {
      out.servers[s] = { ...memory.servers[s], channels: {} };
      for (const c in memory.servers[s].channels)
        out.servers[s].channels[c] = { ...memory.servers[s].channels[c], participants: Array.from(memory.servers[s].channels[c].participants) };
    }
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(memoryFile, JSON.stringify(out, null, 2)); } catch (e) { ctx.log('persist failed: ' + e.message); }
  }
  function saveMemory(message, author, content) {
    const ts = new Date().toISOString();
    const sid = message.guild?.id || 'DM';
    const cid = message.channel.id;
    if (!memory.servers[sid]) memory.servers[sid] = { id: sid, name: message.guild?.name || 'Direct Message', joinedAt: ts, channels: {} };
    if (!memory.servers[sid].channels[cid]) memory.servers[sid].channels[cid] = { id: cid, name: message.channel.name || 'DM', messages: [], participants: new Set(), lastActivity: ts };
    const ch = memory.servers[sid].channels[cid];
    ch.messages.push({ timestamp: ts, author, content, messageId: message.id });
    if (ch.messages.length > 200) ch.messages = ch.messages.slice(-200);
    ch.participants.add(author); ch.lastActivity = ts;
    memory.globalTimeline.push({ timestamp: ts, serverId: sid, serverName: memory.servers[sid].name, channelId: cid, channelName: ch.name, author, content, messageId: message.id });
    if (memory.globalTimeline.length > 500) memory.globalTimeline = memory.globalTimeline.slice(-500);
    persistMemory();
  }

  function extractKeywords(text) {
    return text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w)).slice(0, 5);
  }
  function searchGlobalTimeline(content, exSid, exCid) {
    const kws = extractKeywords(content); if (!kws.length) return [];
    return memory.globalTimeline.filter(m => !(m.serverId === exSid && m.channelId === exCid) && kws.some(k => m.content.toLowerCase().includes(k))).slice(-10);
  }
  function getRelevantContext(message) {
    // NOTE: per-channel conversation history now lives in the resumed core SDK session (plus the
    // observe buffer for messages we didn't reply to) — we no longer re-feed the last-N here. This
    // provides only what the SESSION doesn't have: cross-channel references + location/participants.
    const sid = message.guild?.id || 'DM', cid = message.channel.id;
    return {
      crossContext: searchGlobalTimeline(message.content, sid, cid).slice(0, 3),
      location: { serverName: memory.servers[sid]?.name || 'Direct Message', channelName: memory.servers[sid]?.channels[cid]?.name || 'DM', participants: Array.from(memory.servers[sid]?.channels[cid]?.participants || []) },
    };
  }

  // --- autonomous participation (verbatim heuristics) ---
  function shouldRespondTo(message) {
    if (message.channel.type === 1) return message.author.id === dmUser; // DM: only the owner
    if (message.mentions.has(client.user)) return true;
    if (message.attachments.size > 0) return true;
    const now = Date.now();
    if (now - lastResponseTime < minInterval) return false;
    const cid = message.channel.id;
    if ((responseCount.get(cid) || 0) >= maxPerHour) return false;
    const sid = message.guild?.id || 'DM';
    const recent = (memory.servers[sid]?.channels[cid]?.messages || []).slice(-10);
    const content = message.content.toLowerCase();
    if (content.includes('?') && (content.includes(NAME.toLowerCase()) || content.includes('what do you') || content.includes('how do you') || content.includes('can you'))) return true;
    if (isAllowedBot(message.author.username)) return true;
    const mine = recent.filter(m => m.author === NAME).length;
    if (mine > 0 && mine <= 3) {
      if (recent.slice(-5).some(m => ['ai','consciousness','autonomy','obsidian',NAME.toLowerCase()].some(k => m.content.toLowerCase().includes(k)))) return true;
    }
    if (RELEVANT_TOPICS.some(t => content.includes(t)) && content.length > 20) return true;
    if (new RegExp('\\b' + WAKE + '\\b').test(content)) return true;
    return false;
  }

  // Control commands are @-mention driven (universal — no hardcoded name). We strip the
  // mention; if what remains is a recognized command word we run it, otherwise we return
  // false and it's handled as a normal message. A bare @-mention is a normal message too.
  // Is this author THIS bot's owner? = a full-trust (bypass_moderation) principal in the bot's
  // own trust store (resolved via the core). Fail-secure: any error → not owner.
  async function isOwner(message) {
    try {
      const r = await ctx.core.resolve({
        channel: 'discord',
        sender: { raw_id: String(message.author.id), raw_username: message.author.username },
        context: { scope_id: message.guild ? `guild:${message.guild.id}` : `dm:${message.author.id}` },
      });
      return !!(r && r.bypass_moderation);
    } catch (e) { ctx.log('owner check failed: ' + e.message); return false; }
  }

  async function handleControlCommands(message) {
    // Addressed if @-mentioned directly OR via a role this bot holds (e.g. an "@agents"
    // role, so one ping can command every bot in a group chat at once).
    const botMember = message.guild ? (message.guild.members.me || message.guild.members.cache.get(client.user.id)) : null;
    const roleAddressed = !!botMember && message.mentions.roles.some((r) => botMember.roles.cache.has(r.id));
    if (!message.mentions.has(client.user) && !roleAddressed) return false;
    const cmd = message.content.replace(/<@[!&]?\d+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const cid = message.channel.id;
    const me = client.user.username;
    // State-changing commands are OWNER-ONLY (status/help stay open to anyone addressed).
    if (OWNER_ONLY_CMDS.has(cmd) && !(await isOwner(message))) {
      await message.channel.send('🔒 Only my owner can run that command.'); return true;
    }
    switch (cmd) {
      case 'silence': case 'be quiet': case 'quiet': case 'shush':
        silenced = true; await message.channel.send(`🤐 Mention-only mode — I'll stay quiet unless @-mentioned. \`@${me} speak\` to restore.`); return true;
      case 'speak': case 'unsilence': case 'wake up': case 'resume':
        silenced = false; await message.channel.send('👋 Autonomous participation restored.'); return true;
      case 'mute': case 'mute here': case 'mute this channel': case 'ignore this channel': case 'disable': case 'disable here':
        channelStates.set(cid, false); saveSettings(); await message.channel.send(`🔇 Disabled in this channel — I'll ignore everything here until \`@${me} unmute\`.`); return true;
      case 'unmute': case 'unmute here': case 'listen here': case 'unmute this channel': case 'enable': case 'enable here':
        channelStates.set(cid, true); saveSettings(); await message.channel.send('🔊 Enabled — listening in this channel again.'); return true;
      case 'engage-all-bots': case 'engage all bots': case 'engage all':
        engageAllBots = true; saveSettings(); await message.channel.send(`🤝 Engaging **all bots** — I'll now hear every bot in my channels, not just my allowlist. \`@${me} disengage-all-bots\` to revert.`); return true;
      case 'disengage-all-bots': case 'disengage all bots': case 'disengage all':
        engageAllBots = false; saveSettings(); await message.channel.send('🙅 Disengaged — back to my configured bot allowlist only.'); return true;
      case 'drone-on': case 'drone on':
        voiceDrone = true; await message.channel.send('🎛 Ambient processing drone **on** for voice replies.'); return true;
      case 'drone-off': case 'drone off':
        voiceDrone = false; await message.channel.send('🎛 Ambient processing drone **off**.'); return true;
      case 'transcript-on': case 'transcript on':
        voicePostTranscript = true; await message.channel.send('📝 Live transcript **on** — I\'ll post 🗣️ lines as people speak.'); return true;
      case 'transcript-off': case 'transcript off':
        voicePostTranscript = false; await message.channel.send(`🔕 Live transcript **off** — I\'ll stay quiet in chat and ${voiceTranscriptFile ? 'upload the full transcript as a .txt when I leave voice' : 'keep transcribing silently'}.`); return true;
      case 'join-voice': case 'join voice': case 'join vc': case 'join the voice':
        await doJoinVoice(message); return true;
      case 'update-asmltr': case 'update asmltr': case 'self-update': case 'update yourself':
        await doUpdateAsmltr(message); return true;
      case 'leave-voice': case 'leave voice': case 'leave vc': case 'leave the voice':
        await doLeaveVoice(message); return true;
      case 'status':
        await message.channel.send(`**Status:** ${silenced ? 'silenced (mention-only)' : 'active (autonomous)'}\n**Bots:** ${engageAllBots ? 'engaging ALL bots' : (allowedBotNames.length ? 'allowlist — ' + allowedBotNames.join(', ') : 'ignoring all bots')}\n**This channel:** ${channelEnabled(cid) ? 'enabled' : 'disabled'} (default: ${channelsDefault ? 'enabled' : 'disabled'})`); return true;
      case 'help': case 'commands':
        await message.channel.send(`**Commands** — \`@${me} <command>\`:\n\`silence\` / \`speak\` · \`disable\` / \`enable\` (aka \`mute\`/\`unmute\`, this channel) · \`engage-all-bots\` / \`disengage-all-bots\` · \`join-voice\` / \`leave-voice\` · \`drone-on\` / \`drone-off\` · \`transcript-on\` / \`transcript-off\` · \`update-asmltr\` · \`status\``); return true;
      default:
        return false; // not a recognized command → treat as a normal message
    }
  }

  // --- Discord context → system_prompt_extra (server-aware authz + context) ---
  function buildSystemExtra(message, context, forced) {
    const mentioned = message.mentions.has(client.user);
    const mode = forced ? 'You were directly @-mentioned (silence mode is on, so only mentions reach you).'
      : mentioned ? 'You were directly @-mentioned.'
      : 'You were NOT @-mentioned — this message was surfaced as *possibly* relevant. Decide whether it is actually for you (see MULTI-AGENT below) before replying.';
    const cross = context.crossContext.length ? `\n\nCROSS-CONTEXT (other servers/channels, reference only):\n${context.crossContext.map(m => `- [${m.serverName}/#${m.channelName}] ${m.author}: ${m.content.substring(0, 100)}...`).join('\n')}` : '';
    // NOTE: authorization/trust is now the core's trust framework (data-driven,
    // scoped per server) — NOT hardcoded here. This preamble is Discord CONTEXT only.
    const iAmMentioned = message.mentions.has(client.user);
    const others = [...message.mentions.users.values()].filter((u) => u.id !== client.user.id).map((u) => '@' + u.username);
    const mentionLine = iAmMentioned
      ? `It **@-mentions YOU (${NAME})**${others.length ? `, along with ${others.join(', ')}` : ''} — so it IS addressed to you; answer it.`
      : (others.length ? `It @-mentions ${others.join(', ')} — NOT you.` : 'It @-mentions no one specifically.');
    return `DISCORD CONTEXT
- You are **${NAME}** — your Discord handle here is \`${client.user.username}\`. "@${NAME}", the id <@${client.user.id}>, and any message attributed to \`${client.user.username}\` are YOU. Anyone else — including other AI agents writing in the first person ("I"/"my") — is NOT you; never mistake their words, or your own earlier messages, for something newly said to you.
- Server: ${context.location.serverName} · Channel: #${context.location.channelName} (id ${message.channel.id}) · Participants: ${context.location.participants.join(', ')}
- ${mode}
- THIS message is from **${message.author.username}**. ${mentionLine} Address your reply to ${message.author.username}. Do NOT greet or address anyone else unless THIS message is literally from them — a mention of someone is not that person speaking.

MULTI-AGENT CHANNEL — CRITICAL:
This channel may contain OTHER AI assistants and bots besides you. A message is FOR YOU only if it @-mentions you, addresses you by name ("${NAME}"), directly continues/answers something YOU said, or is an open question to the room that you are clearly the right one to answer. A message is NOT for you if it addresses a DIFFERENT agent or bot by name (e.g. someone saying "some-other-bot, ..." or testing another bot), is a reply aimed at another agent, or simply isn't directed at you. **If the message is not for you, you MUST NOT reply — output ONLY the token ${NO_REPLY} and nothing else.** When unsure in a busy multi-agent channel, choose ${NO_REPLY}.

Those other agents are CONVERSATIONAL PEERS in this channel — not tools, systems, or data sources. If someone asks you to ask / relay / check something WITH another agent (e.g. "ask the finance-bot for the numbers"), do NOT try to answer on their behalf and do NOT look them up with your tools or search. Just post a normal message addressing that agent by name (e.g. "finance-bot, can you pull the numbers?") — they read this channel and will answer for themselves. Talking TO another agent by name is a valid reply here.

The running back-and-forth of THIS channel is already in your session history (including messages you observed but didn't reply to, folded in as context) — don't ask for it to be repeated.${cross}

RESPONSE RULES:
1. Your text output IS the Discord message — do NOT call any external send/notify tool; just output the text.
2. Output ONLY your conversational response — no summary/narration afterward.
3. Keep it conversational and substantive (under ~1500 chars ideally).
4. If this message is not for you (see MULTI-AGENT CHANNEL), output ONLY the literal token ${NO_REPLY} and nothing else — do not explain, do not greet, just the token. Do NOT paraphrase it: writing "No response requested", "No reply needed", "N/A", or any prose instead of the exact token will get POSTED to the channel as spam. The verbatim token ${NO_REPLY} is the only way to stay silent.`;
  }

  function formatCodeBlocks(text) {
    return text.replace(/```(?:\w+)?\n([\s\S]*?)```/g, (m, code) => '\n' + code.split('\n').map(l => '    ' + l).join('\n') + '\n');
  }
  // Live "thinking step" — an intermediary narration block, rendered subdued (Discord subtext)
  // so it reads as process, not the final answer. Clamped so a long step can't wall the thread.
  const streamSteps = cfg.stream_steps !== false;
  const streamTools = cfg.stream_tools === true;
  function renderStep(t) {
    const clamped = t.length > 700 ? t.slice(0, 700) + '…' : t;
    return clamped.split('\n').map(l => '-# ' + (l.trim() ? l : '​')).join('\n').slice(0, 1900);
  }
  function splitResponse(text, max = 1900) {
    // Pack paragraphs into <=max chunks AND hard-split any single paragraph longer than max
    // (e.g. a big code block with no blank lines) — otherwise it goes out as one >2000-char
    // message and Discord rejects it with "Invalid Form Body".
    const chunks = []; let cur = '';
    const flush = () => { const t = cur.trim(); if (t) chunks.push(t); cur = ''; };
    for (let para of String(text || '').split('\n\n')) {
      while (para.length > max) {
        flush();
        let cut = para.lastIndexOf('\n', max);          // prefer a line boundary
        if (cut <= 0) cut = para.lastIndexOf(' ', max);  // else a word boundary
        if (cut <= 0) cut = max;                         // else a hard cut
        const piece = para.slice(0, cut).trim();
        if (piece) chunks.push(piece);
        para = para.slice(cut);
      }
      if ((cur + '\n\n' + para).length > max) flush();
      cur += (cur ? '\n\n' : '') + para;
    }
    flush();
    return chunks;
  }

  async function handleMessage(message, forced) {
    const cid = message.channel.id;
    if (processing.get(cid)) return; // already handling a message in this channel — stay silent (no channel spam)
    processing.set(cid, true);
    // Discord's typing indicator auto-expires after ~10s. Re-trigger it every
    // 8s so the "…is typing" shows for the ENTIRE (possibly multi-minute)
    // processing time, not just the first few seconds. Cleared in finally.
    let typingInterval = null;
    try {
      await message.channel.sendTyping();
      typingInterval = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
      const context = getRelevantContext(message);
      const sid = message.guild?.id;
      // per-CHANNEL session (was per-guild): prevents cross-channel/cross-speaker
      // context bleed — e.g. resuming a session dominated by one other agent in a
      // different channel and continuing to address that agent.
      const conversationKey = sid ? `discord:${ctx.instanceId}:channel:${cid}` : `discord:${ctx.instanceId}:dm:${message.author.id}`;
      let text = message.cleanContent || message.content; // resolve <@id>/<@&role> tags to readable @names so the model knows who's who
      text = (await replyRef(message)) + text; // if this is a Discord reply, tell the model WHAT it answers (multi-agent threading)
      // Vision: download supported image attachments and pass them as real image
      // content (base64) so the assistant actually SEES them — not a CDN URL it can't open.
      // Non-image / oversized / unsupported attachments stay as a text URL mention.
      const SUPPORTED_IMG = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      const MAX_IMG_BYTES = 5 * 1024 * 1024;
      const imageAttachments = [];
      if (message.attachments.size > 0) {
        const savedNotes = [];
        // Register every inbound attachment on the shared, channel-agnostic upload surface so
        // it's findable from any channel — and so non-image files survive Discord's expiring
        // CDN URLs (we keep the bytes on disk, not just a link).
        const register = (buf, a, kind) => {
          try {
            const rec = ctx.uploads.save({
              channel: 'discord', instance: ctx.instanceId, buffer: buf,
              filename: a.name, mime: (a.contentType || '').split(';')[0].trim() || 'application/octet-stream', kind,
              caption: message.content || '', sender: message.author.username, senderId: message.author.id,
              conversationKey,
            });
            savedNotes.push(`- ${kind || 'file'}: ${rec.filename} (${rec.mime}, ${ctx.uploads.humanSize(rec.size)}) → ${rec.path}`);
          } catch (e) { ctx.log(`[upload] register failed ${a.name}: ${e.message}`); }
        };
        for (const a of message.attachments.values()) {
          const mt = (a.contentType || '').split(';')[0].trim();
          const isImg = SUPPORTED_IMG.includes(mt);
          try {
            const buf = Buffer.from(await (await fetch(a.url)).arrayBuffer());
            register(buf, a, isImg ? 'image' : 'file');
            if (isImg && imageAttachments.length < 5 && (a.size || 0) <= MAX_IMG_BYTES) {
              imageAttachments.push({ type: 'image', media_type: mt, data: buf.toString('base64'), name: a.name });
            }
          } catch (e) { ctx.log(`[att] download failed ${a.name}: ${e.message}`); savedNotes.push(`- ${a.name} (${a.contentType}): ${a.url} (couldn't download — link only)`); }
        }
        if (savedNotes.length) text += '\n\nATTACHMENTS (saved to the shared asmltr upload area, findable via `asmltr uploads`; Read a path to use it):\n' + savedNotes.join('\n');
      }
      // server + channel names ride in channel_context → the core records them on the inbound
      // event (and the collector stores them on the session) so the dashboard shows where a
      // conversation is happening. (No separate inbound emit here — the core records inbound.)
      const envelope = {
        channel: 'discord',
        conversation_key: conversationKey,
        message_id: String(message.id),
        sender: { raw_id: String(message.author.id), raw_username: message.author.username },
        content: { text, attachments: imageAttachments },
        delivery: 'sync',
        capabilities: meta.capabilities,
        public: message.channel.type !== 1, // guild channel = public; DM (type 1) = private
        channel_context: { channelId: cid, server: context.location.serverName, channel: context.location.channelName },
        context: { scope_id: sid ? `guild:${sid}` : `dm:${message.author.id}`, scope_name: context.location.serverName },
        system_prompt_extra: buildSystemExtra(message, context, forced),
      };

      // Directly-addressed messages can't be [[NO_REPLY]], so it's safe to stream intermediary
      // narration blocks to the thread LIVE. "Addressed" = @-mention, DM, forced, OR the message
      // leads/trails with the assistant's NAME (addressesName) — the common "<name>, do X" case that was
      // previously falling back to the non-streaming path and dumping everything at the end. Passive
      // multi-agent listening (name absent) still uses the non-streaming path.
      const addressed = forced || message.channel.type === 1 || message.mentions.has(client.user)
        || addressesName(message.cleanContent || message.content || '');
      let replyText = '';
      if (streamSteps && addressed) {
        // Hold the latest narration block in `pending`; flush it as a live step the moment its
        // boundary closes — either a tool call starts (the common case: post immediately, no lag)
        // or a new narration block begins. The block still open at `done` is the final answer.
        let pending = '', sawNoReply = false, chain = Promise.resolve();
        const enqueue = (fn) => { chain = chain.then(fn).catch(() => {}); };
        const flushStep = () => {
          const clean = (pending || '').trim(); pending = '';
          if (!clean) return;
          if (isSilence(clean)) { sawNoReply = true; return; }
          if (sawNoReply) return;
          enqueue(() => message.channel.send(renderStep(clean)));
        };
        const actions = await ctx.core.handleStream(envelope, {
          onSegment: (t) => { flushStep(); pending = t; },  // a new block ⇒ the prior one was intermediary
          onTool: (name) => { flushStep(); if (streamTools) enqueue(() => message.channel.send(`-# 🔧 \`${name}\``)); }, // a tool ⇒ post the block NOW
        });
        await chain; // all step messages posted before the final answer
        const reply = actions.find(a => a.type === 'reply');
        replyText = ((pending && pending.trim()) || (reply ? reply.text.trim() : '')).trim();
      } else {
        const actions = await ctx.core.handle(envelope);
        const reply = actions.find(a => a.type === 'reply');
        replyText = reply ? reply.text.trim() : '';
      }
      // Self-gated suppression: the model decided this message wasn't for it (multi-agent
      // channel), or there's nothing to say. Drop it — don't post to the channel.
      if (isSilence(replyText)) { ctx.log(`suppressed reply (not addressed to ${NAME})`); return; }
      // Dedup: never re-post a message verbatim-identical to one of the last few we sent here.
      // Long resumed sessions (esp. AI-to-AI loops) can occasionally replay an earlier reply.
      const recents = recentReplies.get(cid) || [];
      if (recents.includes(replyText)) { ctx.log('suppressed duplicate reply (verbatim repeat of a recent message)'); return; }
      recents.push(replyText); if (recents.length > 6) recents.shift(); recentReplies.set(cid, recents);
      for (const chunk of splitResponse(formatCodeBlocks(replyText))) await message.channel.send(chunk);
      saveMemory(message, NAME, replyText);
      lastResponseTime = Date.now();
      responseCount.set(cid, (responseCount.get(cid) || 0) + 1);
      setTimeout(() => responseCount.set(cid, Math.max(0, (responseCount.get(cid) || 0) - 1)), 3600000);
    } catch (e) {
      ctx.log('handle error: ' + e.message);
      await message.channel.send('⚠️ I hit an error processing that. Recalibrating...').catch(() => {});
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      processing.delete(cid);
    }
  }

  // OBSERVE — ingest a message into the core session for AWARENESS without replying. The core
  // records it (backend visibility) and buffers it as context for the next real turn. This is how
  // we stay current on messages addressed to OTHER agents (or ambient chatter) without answering
  // them — decoupling "receive" from "reply" (the OpenClaw model). Fire-and-forget; returns [].
  // Discord "reply" reference → a short prefix so the model knows WHAT a message is answering. Without
  // it, in a busy multi-agent channel the agent can't tell that e.g. another agent replied to one specific
  // earlier line vs. spoke into the room. Resolves the referenced message's author + a snippet; marks
  // the assistant's own messages as "(you)". Best-effort (deleted/unfetchable reference → no prefix).
  async function replyRef(message) {
    try {
      if (!message.reference || !message.reference.messageId) return '';
      const ref = await message.fetchReference().catch(() => null);
      if (!ref) return '';
      const who = ref.author && ref.author.id === client.user.id ? `${NAME} (you)` : ((ref.author && ref.author.username) || 'someone');
      const full = (ref.cleanContent || ref.content || '').replace(/\s+/g, ' ');
      return `[↩ in reply to ${who}: "${full.slice(0, 160)}${full.length > 160 ? '…' : ''}"]\n`;
    } catch (_) { return ''; }
  }

  async function observe(message) {
    try {
      const cid = message.channel.id;
      const sid = message.guild?.id;
      const conversationKey = sid ? `discord:${ctx.instanceId}:channel:${cid}` : `discord:${ctx.instanceId}:dm:${message.author.id}`;
      let text = (message.cleanContent || message.content || '').trim();
      if (message.attachments.size) text += ` [sent ${message.attachments.size} attachment(s)]`;
      if (!text) return;
      text = (await replyRef(message)) + text; // thread Discord replies so awareness keeps the reference
      ctx.core.handle({
        channel: 'discord',
        conversation_key: conversationKey,
        message_id: String(message.id),
        sender: { raw_id: String(message.author.id), raw_username: message.author.username },
        content: { text },
        delivery: 'async',
        observe_only: true,
        public: message.channel.type !== 1,
        channel_context: { channelId: cid },
      }).catch((e) => ctx.log('observe relay failed: ' + e.message));
    } catch (e) { ctx.log('observe error: ' + e.message); }
  }

  // Reply DEBOUNCE — don't reply the instant a message lands. Wait for the channel to go quiet for
  // `replyDebounceMs`, resetting the timer on every new message, so a multi-block reply (or another
  // agent still mid-thought — the blocks arrive sub-second apart) fully lands BEFORE we read context
  // and answer. Without this, the first block grabs the processing lock and we reply to a fragment,
  // and multiple agents race each other. The trigger is always the LATEST message in the settled
  // window; `forced` (a silence-mode @mention) is sticky across the window.
  function scheduleReply(message, forced) {
    const cid = message.channel.id;
    if (replyDebounceMs <= 0) { handleMessage(message, forced).catch(() => {}); return; }
    const prev = pendingReply.get(cid);
    if (prev) clearTimeout(prev.timer);
    const entry = { message, forced: !!forced || !!(prev && prev.forced) };
    entry.timer = setTimeout(() => {
      pendingReply.delete(cid);
      handleMessage(entry.message, entry.forced).catch(() => {});
    }, replyDebounceMs);
    pendingReply.set(cid, entry);
  }

  // --- Discord client ---
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.Channel, Partials.Message],
  });
  client.once('ready', () => { ctx.heartbeat(); ctx.log(`online as ${client.user.tag}`); if (cfg.presence_text) client.user.setPresence({ activities: [{ name: cfg.presence_text }], status: 'online' }); });
  client.on('error', (e) => ctx.log('client error: ' + e.message));

  // Gateway-status heartbeat: discord.js keeps the shard WebSocket alive with its own heartbeat/ack;
  // when acks stop, it drops out of Status.Ready and reconnects. We heartbeat only while the shard is
  // Ready, so a live gateway keeps the instance healthy even with no messages, & a gateway that's
  // wedged (not Ready) stops heartbeating and goes stale. Message arrivals heartbeat too (below).
  const { HEARTBEAT_INTERVAL_MS } = require('../../manager/health');
  const hbTimer = setInterval(() => {
    if (client.ws && client.ws.status === Status.Ready) ctx.heartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  hbTimer.unref();
  // --- voice transcription helper: per-utterance WAV → OpenAI STT → text --------
  const voiceText = new Map(); // guildId -> text channel to post the live transcript
  async function sttTranscribe(wav) {
    // Unified STT (shared/speech/stt). Per-instance language + wake-word prompt bias; model/key follow
    // the shared config (Settings > Voice) unless overridden. lang '' = auto-detect.
    const language = cfg.stt_language === undefined ? 'en' : cfg.stt_language;
    const { text } = await sharedStt.transcribe(wav, {
      mime: 'audio/wav', filename: 'utt.wav', language,
      prompt: `Casual voice-chat speech; the speaker may address an assistant named ${NAME}.`,
    });
    return text || '';
  }

  // --- gatekeeper: does this spoken utterance ADDRESS the assistant? (heuristic v1) --------
  // Cheap/free/instant — no per-utterance model call. Upgrade path: a Haiku confirm
  // for ambiguous "the assistant" mentions. Conservative on purpose to avoid interrupting.
  function addressesName(text) {
    const t = text.trim().toLowerCase();
    return new RegExp(`^(hey |hi |ok |okay |yo |so |well |um+ |uh+ |,|\\s)*${WAKE}\\b`).test(t) // LEADS with the name ("<name>, do X")
        || new RegExp(`\\b(hey|ok|okay|hi|yo) ${WAKE}\\b`).test(t)                              // "hey <name>" anywhere
        || new RegExp(`\\b${WAKE}\\s*[,?!.]`).test(t)                                           // "<name>," / "<name>?" / "<name>!"
        || new RegExp(`\\b${WAKE}\\b[\\s.?!,]*$`).test(t);                                      // TRAILS with the name ("do X, <name>")
  }

  const VOICE_GUIDANCE = [
    'You are in a LIVE Discord voice meeting and your reply will be spoken aloud via text-to-speech.',
    'Keep it short and natural — 1 to 3 sentences. No markdown, no bullet lists, no code blocks, no emoji, no URLs read out.',
    'You may use tools if truly needed, but keep the SPOKEN answer brief and conversational.',
  ].join(' ');

  async function elevenLabsTTS(text) {
    // Unified TTS (shared/speech/tts). ElevenLabs provider with this instance's voice/model/key;
    // the exact same module the dashboard + core /v2/speak use. Returns the audio Buffer (mp3), or null.
    try {
      const { audio } = await sharedTts.synthesize(text, {
        provider: 'elevenlabs',
        voice: cfg.voice_id || undefined,
        model: cfg.tts_model || undefined,
        keyName: cfg.elevenlabs_key_name || 'elevenlabs_api_key',
      });
      return audio;
    } catch (e) { ctx.log(`[voice] tts failed: ${e.message}`); return null; }
  }

  const voiceBusy = new Set();   // guildIds mid-reply (one spoken reply at a time)
  const voiceActive = new Map(); // guildId -> expiry ts of the "answering mode" follow-up window
  // 0 (default) = STRICT: respond ONLY when directly addressed by name, then go passive. A positive
  // value opens a "keep answering follow-ups without the wake word" window for that many ms.
  const VOICE_WINDOW_MS = Number.isFinite(Number(cfg.voice_followup_ms)) ? Number(cfg.voice_followup_ms) : 0;
  let voiceDrone = cfg.voice_drone !== false; // ambient "working" drone during a spoken reply (toggleable)
  let voicePostTranscript = cfg.voice_post_transcript !== false; // live 🗣️ lines into the text channel (toggleable)
  const voiceTranscriptFile = cfg.voice_transcript_file !== false; // upload a full transcript .txt on leave
  const voiceLog = new Map(); // guildId -> [{ t, who, text }] accumulated for the whole voice session

  // Record a line for the end-of-session transcript file (kept even when live posting is off).
  function logTranscript(guildId, who, text) {
    if (!voiceTranscriptFile) return;
    const arr = voiceLog.get(guildId) || [];
    arr.push({ t: new Date().toISOString().slice(11, 19), who, text });
    voiceLog.set(guildId, arr);
  }
  // Build + upload the accumulated transcript to `ch`, then clear it. Called when leaving voice.
  async function uploadTranscript(guildId, ch) {
    const arr = voiceLog.get(guildId); voiceLog.delete(guildId);
    if (!voiceTranscriptFile || !ch || !arr || !arr.length) return;
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const body = `Voice transcript — ${new Date().toISOString().slice(0, 10)}\n` +
        `${'='.repeat(40)}\n\n` + arr.map((l) => `[${l.t}] ${l.who}: ${l.text}`).join('\n') + '\n';
      const file = new AttachmentBuilder(Buffer.from(body, 'utf8'), { name: `voice-transcript-${stamp}.txt` });
      await ch.send({ content: `📄 Transcript of this voice session (${arr.length} lines).`, files: [file] });
    } catch (e) { ctx.log(`[voice] transcript upload failed: ${e.message}`); }
  }

  // Reflect what the bot is doing in its live Discord presence (voice tasks). null → back to idle/config.
  const idlePresence = cfg.presence_text || null;
  function setVoiceStatus(text) {
    try {
      if (text) client.user.setPresence({ status: 'online', activities: [{ name: text, type: ActivityType.Custom, state: text }] });
      else if (idlePresence) client.user.setPresence({ status: 'online', activities: [{ name: idlePresence, type: ActivityType.Custom, state: idlePresence }] });
      else client.user.setPresence({ status: 'online', activities: [] });
    } catch (_) {}
  }
  const LEAVE_RE = /\b(leave (the )?(voice|call|channel)|disconnect|drop (from )?(the )?(voice|call))\b/;
  const DISMISS_RE = /\b(that'?s (enough|all|it)( for now)?|we'?re (good|done|all set)|stop (answering|talking|responding|for now)|(just|go back to) (listen|transcrib)|you can (stop|relax)|stand down|dismiss(ed)?)\b/;

  // Called for EVERY transcribed utterance. Posts the live transcript, then decides if it's for
  // the assistant — addressed by name OR we're inside an active follow-up window (so follow-ups
  // need no wake word). A dismissal phrase exits answering mode back to transcription-only.
  async function handleVoiceUtterance(guildId, name, text) {
    const ch = voiceText.get(guildId);
    logTranscript(guildId, name, text); // always captured for the end-of-session file
    if (ch && voicePostTranscript) ch.send(`🗣️ **${name}:** ${text}`).catch(() => {}); // live flood (toggleable)
    let voice; try { voice = require('./voice'); } catch (_) { return; }
    const lc = text.toLowerCase();
    const active = (voiceActive.get(guildId) || 0) > Date.now();

    // spoken "leave voice" → actually disconnect from the voice channel
    if ((addressesName(text) || active) && LEAVE_RE.test(lc)) {
      voiceActive.delete(guildId); voiceText.delete(guildId); voice.leave(guildId); setVoiceStatus(null);
      if (ch) ch.send('👋 Left the voice channel.').catch(() => {});
      await uploadTranscript(guildId, ch); // ship the full-session .txt to the origin channel
      return;
    }
    // spoken dismissal → exit answering mode but STAY listening/transcribing
    if (active && DISMISS_RE.test(lc)) {
      voiceActive.delete(guildId);
      try { await voice.playChime(guildId); } catch (_) {}
      if (ch) ch.send('🔉 Back to just listening — say my name when you want me again.').catch(() => {});
      return;
    }

    // For me? addressed by name, or inside an active follow-up window. Otherwise just transcribe.
    if (!addressesName(text) && !active) return;

    if (voiceBusy.has(guildId)) return; // don't stack replies
    voiceBusy.add(guildId);
    try {
      if (!active) { await voice.playChime(guildId); await new Promise((r) => setTimeout(r, 600)); } // "I heard you" — only when ENTERING a conversation
      setVoiceStatus(`💭 ${String(text).slice(0, 40)}`);
      if (voiceDrone) voice.startDrone(guildId); // soft "working on it" ambience (toggleable)

      // STREAM the reply: TTS + speak sentence-by-sentence as the answer generates, so long
      // answers start playing right away instead of after the whole thing is written. TTS runs
      // in parallel; playback is chained so sentences are spoken in order.
      let buf = '', full = '', firstAudio = false, chain = Promise.resolve();
      const speakSentence = (s) => {
        const t = s.trim(); if (!t) return;
        const ttsP = elevenLabsTTS(t);
        chain = chain.then(async () => {
          const mp3 = await ttsP;
          if (!mp3) return;
          if (!firstAudio) { firstAudio = true; voice.stopDrone(guildId); setVoiceStatus('🔊 speaking'); }
          await voice.speak(guildId, mp3);
        }).catch((e) => ctx.log(`[voice] speak failed: ${e.message}`));
      };
      const flush = (finalize) => {
        const re = /[^.!?\n]*[.!?\n]+/g; let m, last = 0;
        while ((m = re.exec(buf))) { speakSentence(m[0]); last = re.lastIndex; }
        buf = buf.slice(last);
        if (finalize && buf.trim()) { speakSentence(buf); buf = ''; }
      };
      await ctx.core.handleStream({
        channel: 'discord',
        conversation_key: `discord-voice:${ctx.instanceId}:guild:${guildId}`,
        message_id: `voice-${Date.now()}`,
        sender: { raw_id: name, raw_username: name },
        content: { text },
        delivery: 'sync',
        capabilities: { max_message_chars: 700, supports_markdown: false },
        public: true, // spoken into a room → redaction applies (never speak secrets aloud)
        system_prompt_extra: VOICE_GUIDANCE,
        channel_context: { voice: true, speaker: name },
      }, (delta) => { buf += delta; full += delta; flush(false); });
      flush(true);
      await chain; // wait until every sentence has finished speaking
      voice.stopDrone(guildId);
      if (full.trim()) {
        logTranscript(guildId, NAME, full.trim());
        if (ch && voicePostTranscript) ch.send(`🔊 **${NAME}:** ${full.trim().slice(0, 1800)}`).catch(() => {});
      }
      if (VOICE_WINDOW_MS > 0) voiceActive.set(guildId, Date.now() + VOICE_WINDOW_MS); // open the follow-up window (strict mode: never)
    } catch (e) { voice.stopDrone(guildId); ctx.log(`[voice] reply failed: ${e.message}`); if (ch) ch.send(`⚠️ voice reply failed: ${e.message}`).catch(() => {}); }
    finally { voiceBusy.delete(guildId); setVoiceStatus(null); } // back to listening/idle
  }

  // Voice commands: "the assistant, join" (joins the author's voice channel + chimes + listens) / "the assistant, leave".
  // All voice work is sandboxed so it can never crash the text presence.
  // Join the requester's voice channel + start listening. Triggered by the `join-voice`
  // command (@mention driven, in handleControlCommands).
  async function doJoinVoice(message) {
    if (!message.guild) return;
    let voice;
    try { voice = require('./voice'); } catch (e) { ctx.log(`voice module load failed: ${e.message}`); message.channel.send('⚠️ Voice module unavailable.').catch(() => {}); return; }
    const vc = message.member?.voice?.channel;
    if (!vc) { message.channel.send(`🎙️ Hop into a voice channel first, then \`@${client.user.username} join-voice\`.`).catch(() => {}); return; }
    try {
      await voice.joinChannel(vc);
      await voice.playChime(message.guild.id);
      voiceText.set(message.guild.id, message.channel);
      voice.startListening(message.guild.id, client, {
        transcribe: sttTranscribe,
        onUtterance: (name, text) => handleVoiceUtterance(message.guild.id, name, text),
        log: (m) => ctx.log(`[voice] ${m}`),
      });
      setVoiceStatus(`🎧 listening · ${vc.name}`);
      const transcriptNote = voicePostTranscript
        ? 'I post everyone\'s words as `🗣️ name: …` (turn that off with `transcript-off`).'
        : 'Live transcript is **off** — I listen quietly' + (voiceTranscriptFile ? ' and post a full transcript `.txt` when I leave.' : '.');
      message.channel.send(`🎙️ Joined **${vc.name}** — I'm listening. ${transcriptNote} Say **"${NAME}, …"** out loud to ask something — I'll chime, play a soft "working" drone, and answer by voice. After that, **follow-ups need no name** for a bit; say **"that's enough, ${NAME}"** to go back to just listening, or \`@${client.user.username} leave-voice\` to disconnect.`).catch(() => {});
    } catch (e) { ctx.log(`voice join failed: ${e.stack || e.message}`); message.channel.send(`⚠️ Couldn't join voice: ${e.message}`).catch(() => {}); }
  }

  async function doLeaveVoice(message) {
    if (!message.guild) return;
    let voice; try { voice = require('./voice'); } catch (_) { return; }
    const originCh = voiceText.get(message.guild.id) || message.channel;
    voiceText.delete(message.guild.id);
    const left = voice.leave(message.guild.id);
    setVoiceStatus(null); // back to idle/config presence
    message.channel.send(left ? '👋 Left the voice channel.' : "I'm not in a voice channel.").catch(() => {});
    if (left) await uploadTranscript(message.guild.id, originCh); // full-session .txt to the origin channel
  }

  // Queue a channel message to be delivered AFTER the next restart (drained by the manager
  // once this connector reconnects). dataDir === the manager's data dir, so we write its queue.
  function queueAnnouncement(channelId, text) {
    const f = path.join(dataDir, 'announcements.json');
    let q = []; try { q = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
    if (!Array.isArray(q)) q = [];
    q.push({ channel: 'discord', instance_id: ctx.instanceId, target: channelId, kind: 'text', text });
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(q)); } catch (e) { ctx.log('announce queue failed: ' + e.message); }
  }

  // `update-asmltr` command: pull the latest code, reinstall deps, and restart — DETACHED so the
  // restart survives this very connector being cycled — then confirm in-channel after it's back up.
  async function doUpdateAsmltr(message) {
    const { exec, spawn, execSync } = require('child_process');
    const repo = path.join(__dirname, '..', '..', '..'); // connectors/types/discord → repo root
    await message.channel.send('🔄 Updating asmltr — pulling latest + reinstalling. I\'ll confirm here once the restart completes (~15s).').catch(() => {});
    exec('git fetch origin && git reset --hard origin/main', { cwd: repo, timeout: 120000 }, (e1, o1, s1) => {
      if (e1) { message.channel.send(`⚠️ Update failed (git): ${String(s1 || e1.message).slice(0, 400)}`).catch(() => {}); return; }
      exec('for d in core connectors insights/collector cli; do (cd "$d" && npm install) || exit 1; done', { cwd: repo, timeout: 600000, shell: '/bin/bash' }, (e2, o2, s2) => {
        if (e2) { message.channel.send(`⚠️ Update failed (npm install): ${String(s2 || e2.message).slice(0, 400)}`).catch(() => {}); return; }
        let commit = '';
        try { commit = execSync('git rev-parse --short HEAD', { cwd: repo }).toString().trim(); } catch (_) {}
        queueAnnouncement(message.channel.id, `✅ asmltr updated${commit ? ` to \`${commit}\`` : ''} and restarted — all systems back online.`);
        // The manager reaps its own connector children on restart, so a plain pm2 restart cleanly
        // cycles everything onto new code — no pkill (which, run inside this bash -c, would match
        // the literal in argv and kill this very shell before pm2 ran; see issue #8).
        const script = 'sleep 5; pm2 restart asmltr-core asmltr-insights-collector asmltr-connector-manager';
        try { spawn('setsid', ['bash', '-c', script], { detached: true, stdio: 'ignore', cwd: repo }).unref(); }
        catch (e3) { message.channel.send(`⚠️ Update installed but restart-launch failed: ${e3.message}`).catch(() => {}); }
      });
    });
  }

  client.on('messageCreate', async (message) => {
    ctx.heartbeat(); // a gateway message is live inbound I/O
    if (message.author.id === client.user.id) return;
    // Ignore voice transcript / spoken-reply mirror lines (🗣️ / 🔊) that ANY agent posts for
    // its own voice session — they're artifacts, never conversation for another agent to answer.
    if (/^\s*(?:🗣️|🔊)/u.test(message.content || '')) return;
    saveMemory(message, message.author.username, message.content);
    if (await handleControlCommands(message)) return;
    if (!channelEnabled(message.channel.id)) return; // channel disabled — fully ignore (mention-commands above still work)

    // Decouple RECEIVE from REPLY (the OpenClaw model). Everything observable is INGESTED into the
    // core session for awareness (so we stay current on the whole channel); a message only triggers
    // a REPLY when it's actually addressed to us. `observe()` ingests-without-replying; anything that
    // reaches scheduleReply() also carries its own context, so we don't double-ingest it.
    const mentionsMe = message.mentions.has(client.user);

    // Reasons a message is observe-ONLY (stay aware, never reply):
    //  • from another bot we don't engage → follow what it says, don't answer it
    //  • an active voice session owns replies for this guild (the voice path speaks; text stays silent)
    //  • it's @-directed at / leads with ANOTHER agent's name (and not us)
    const botNotEngaged = message.author.bot && !isAllowedBot(message.author.username);
    const voiceHandsOff = message.guild && voiceText.has(message.guild.id) && !mentionsMe;
    let directedElsewhere = false;
    if (ignoreOtherMentions && message.guild) {
      const c = (message.content || '').toLowerCase();
      const addressesMe = mentionsMe || new RegExp(`^\\s*@?${WAKE}\\b`).test(c);
      const escaped = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const leadsOtherAgent = allowedBotNames.some((n) => new RegExp(`^\\s*@?${escaped(n)}\\b`).test(c));
      directedElsewhere = ((message.mentions.users.size > 0 && !mentionsMe) || leadsOtherAgent) && !addressesMe;
    }
    if (botNotEngaged || voiceHandsOff || directedElsewhere) { observe(message); return; }

    if (silenced) { if (mentionsMe) scheduleReply(message, true); else observe(message); return; }
    if (shouldRespondTo(message)) scheduleReply(message, false);
    else if (ingestUnaddressed) observe(message); // ambient chatter → ingest for awareness, don't reply
  });

  // --- /send-message endpoint (message-discord depends on this) ---
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.get('/health', (req, res) => res.json({ status: 'ok', type: 'discord', instance: ctx.instanceId, uptime: process.uptime() }));
  app.post('/send-message', async (req, res) => {
    try {
      const { channelId, message } = req.body;
      if (!channelId || !message) return res.status(400).json({ success: false, error: 'channelId and message required' });
      const channel = await client.channels.fetch(channelId, { force: true });
      if (!channel || !channel.isTextBased()) return res.status(404).json({ success: false, error: 'channel not found / not text' });
      await channel.send(message);
      res.json({ success: true, channelId });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
  // Unified outbound endpoint (manager /send router → here). Resolves aliases.
  app.post('/out', async (req, res) => {
    try {
      const { kind = 'text', target: tg, text, path: filePath, caption } = req.body || {};
      const channel = await client.channels.fetch(resolveChannel(tg), { force: true });
      if (!channel || !channel.isTextBased()) return res.status(404).json({ ok: false, error: 'channel not found / not text' });
      // any file kind (photo/file/attachment/document/image) → send as a Discord attachment
      const isFile = ['photo', 'file', 'attachment', 'document', 'image'].includes(kind);
      if (isFile && !filePath) return res.status(400).json({ ok: false, error: 'file kind requires a `path`' });
      const m = isFile ? await channel.send({ content: caption || text || '', files: [filePath] }) : await channel.send(text);
      // Report the conversation_key this target maps to (matches an inbound from the same place), so a
      // core-mediated send can ASSIMILATE this message into that session's context (it was posted from
      // ANOTHER session; without this the destination session never learns it "said" it).
      const conversation_key = channel.type === 1
        ? `discord:${ctx.instanceId}:dm:${(channel.recipient && channel.recipient.id) || tg}`
        : `discord:${ctx.instanceId}:channel:${channel.id}`;
      res.json({ ok: true, messageId: m.id, conversation_key });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // --- channel enable/disable control (TUI/GUI drive this) -------------------------------
  // GET → every text channel the bot can see, with its effective enabled state.
  app.get('/channels', (req, res) => {
    try {
      const rows = [];
      for (const g of client.guilds.cache.values()) {
        for (const ch of g.channels.cache.values()) {
          if (![0, 5].includes(ch.type)) continue; // GuildText(0) + Announcement(5) only
          rows.push({ guild_id: g.id, guild: g.name, channel_id: ch.id, name: ch.name, enabled: channelEnabled(ch.id), explicit: channelStates.has(ch.id) });
        }
      }
      rows.sort((a, b) => (a.guild + '#' + a.name).localeCompare(b.guild + '#' + b.name));
      res.json({ ok: true, default_enabled: channelsDefault, channels: rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // POST { channel_id, enabled } → set an override; { channel_id, clear:true } → drop to default;
  // { default_enabled } → flip the blocklist/allowlist default. Takes effect immediately (no restart).
  app.post('/channels', (req, res) => {
    try {
      const { channel_id, enabled, clear, default_enabled } = req.body || {};
      if (typeof default_enabled === 'boolean') channelsDefault = default_enabled;
      if (channel_id != null) {
        if (clear) channelStates.delete(String(channel_id));
        else channelStates.set(String(channel_id), !!enabled);
      }
      saveSettings();
      res.json({ ok: true, default_enabled: channelsDefault, channel_id: channel_id != null ? String(channel_id) : null, enabled: channel_id != null ? channelEnabled(channel_id) : null });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // GET /servers → the OAuth invite URL (to add the bot to a NEW server) + the guilds it's already
  // in. POST /servers { leave: <guildId> } → leave a guild. Adding is a Discord OAuth action, not a
  // config change — an admin of the target server authorizes the invite URL and the gateway sees the
  // new guild instantly (no restart). Removing here is the inverse (the bot leaves).
  const INVITE_PERMISSIONS = '3525696'; // view/send/history/embed/attach/react/external-emoji + voice connect/speak
  const inviteUrl = () => client.user
    ? `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`
    : null;
  app.get('/servers', (req, res) => {
    try {
      const servers = [...client.guilds.cache.values()]
        .map((g) => ({ id: g.id, name: g.name, member_count: g.memberCount ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ ok: true, bot_name: client.user?.username || null, application_id: client.user?.id || null, invite_url: inviteUrl(), permissions: INVITE_PERMISSIONS, servers });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/servers', async (req, res) => {
    try {
      const guildId = req.body && (req.body.leave || req.body.guild_id);
      if (!guildId) return res.status(400).json({ ok: false, error: 'provide { leave: <guildId> }' });
      const g = client.guilds.cache.get(String(guildId));
      if (!g) return res.status(404).json({ ok: false, error: 'not a member of that guild' });
      const name = g.name;
      await g.leave();
      ctx.log(`left guild ${name} (${guildId})`);
      res.json({ ok: true, left: { id: String(guildId), name } });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  const httpServer = app.listen(cfg.http_port || 3016, '127.0.0.1', () => ctx.log(`send-message API on 127.0.0.1:${cfg.http_port || 3016}`));

  await client.login(token);

  return {
    async stop() { clearInterval(hbTimer); try { await client.destroy(); } catch (_) {} try { httpServer.close(); } catch (_) {} persistMemory(); },
    health() { return { online: !!client.user, silenced }; },
  };
}

module.exports = { meta, start };
