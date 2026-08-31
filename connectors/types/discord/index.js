'use strict';
/**
 * asmltr connector type: DISCORD — full-feature Discord adapter.
 *
 * All Discord-specific behavior stays HERE (the plugin): hierarchical memory,
 * autonomous-participation logic, control commands, fenced-block split +
 * chunking, and the /send-message HTTP endpoint (message-discord depends on it).
 * The LLM turn goes through asmltr-core: the rich Discord context + server-aware
 * authorization rides as `system_prompt_extra`; content.text is the clean user
 * message (so moderation + identity work correctly). Continuity is per-channel
 * (conversation_key), not per-guild. DMs are per user.
 *
 * conversation_key = discord:<instanceId>:channel:<channelId>  (DMs: :dm:<userId>)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Partials, ActivityType, AttachmentBuilder, Status } = require('discord.js');
const { requireConnectorToken } = require('../../../shared/connector-http-auth');
// THE shared asmltr speech layer — same TTS/STT used by the dashboard + core /v2/speak (DRY).
const sharedTts = require('../../../shared/speech/tts');
const { auxUsage, estimateAudioSeconds } = require('../../../shared/usage'); // priced tts/stt cost events
const sharedStt = require('../../../shared/speech/stt');
const sharedWake = require('../../../shared/speech/wake');            // shared confidence-gated wake matcher (#136)
const voiceEngines = require('../../../shared/speech/voice-engines'); // pluggable STT/TTS role layer (#113/#139)
const converseGrok = require('../../../shared/speech/converse-grok'); // Live grok-voice-think-fast-2.0 WS
const liveTools = require('../../../shared/speech/live-tools');
const vault = require('../../../shared/vault');

// Assistant identity — the display name AND the spoken wake word for voice.
const NAME = process.env.ASSISTANT_NAME || 'Assistant';
const WAKE = NAME.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // regex-escaped
// Self-gating sentinel: in a multi-agent channel the model emits ONLY this token when a
// message isn't meant for it, and the connector drops the reply instead of posting it.
const NO_REPLY = '[[NO_REPLY]]';
const { isNoReplySentinel } = require('../../../shared/silence');
const { parseReact } = require('../../../shared/react-token');
const { looksLikePromptRestatement, discordToolLine, discordThoughtLine, speakerHintsFrom, mergeSpeakerLastNames, publicBlockHints, privacyHitKind, pickPublicReply, thoughtBudget, isImageGenTool, THINK_HEARTBEAT_MS, WORKING_LINE, STILL_WORKING_LINE, GENERATING_LINE } = require('../../../shared/step-public');
const { injectBy } = require('./inject-by');
const { splitResponse } = require('../../../shared/discord-split');
const abortAllow = require('./abort-allow');
const { shouldBargeIn } = require('./barge-in');
const { shouldPlayWakeChime } = require('./wake-chime');
const { shouldAcceptFollowUp, resolveVoiceFollowupMs, armFollowUp, lastSpeakerId: lastSpeakerFromWindow } = require('./voice-followup');
const { countHumans, roomInstructions, shouldForceTurn, wasNotForHer, roomSkipNote, isGroupAddressee } = require('./live-room');
const {
  isTranscriptOff, setTranscriptOff, serializeTranscriptOff, loadTranscriptOff,
  isTranscriptOffCmd, isTranscriptOnCmd, shouldPostLive, shouldUploadLeaveFile,
} = require('./transcript-channel');
const voiceTools = require('./voice-tools');
const { referentPromptBlock, shouldQueueLateMedia, isReplyToUs } = require('./referent');
const { updateResetArgv, fetchOriginArgv } = require('../../../shared/update-ref');
const { crossContextForPrompt, crossContextBlock } = require('./prompt-cross');
// The model sometimes PARAPHRASES the sentinel ("No response requested.", "No reply needed",
// "[no response]") instead of emitting the exact token — those must be dropped too, or the
// paraphrase gets posted as a message. The length guard keeps a genuine reply that merely
// mentions the phrase from being swallowed: only a short, self-contained refusal counts as silence.
// The token itself is exact / last-line only — a mention in a real reply must still post.
function isSilence(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (isNoReplySentinel(t)) return true;
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
  'scribe-on', 'scribe on', 'scribe-off', 'scribe off',
  'join-voice', 'join voice', 'join vc', 'join the voice', 'leave-voice', 'leave voice', 'leave vc', 'leave the voice',
  'mute-voice', 'mute voice', 'voice-mute', 'unmute-voice', 'unmute voice', 'voice-unmute',
  'update-asmltr', 'update asmltr', 'self-update', 'update yourself',
]);

const meta = {
  type: 'discord',
  displayName: 'Discord',
  supportsMultiple: true,
  capabilities: { max_message_chars: 2000, supports_markdown: true, supports_code_blocks: true, supports_attachments_out: true },
  credentialKeys: ['bot_token_bws_key'],
  // How the Access page presents identifiers for this surface (trust framework).
  identifierFormats: [{ surface: 'discord', label: 'Discord User ID', placeholder: '000000000000000000', pattern: '^\\d+$' }],
  outbound: { kinds: ['text', 'photo', 'file'], target: { required: true, label: 'Channel id or alias (e.g. general)' } },
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
      voice_followup_ms: { type: 'integer', title: 'Voice follow-up window (ms) after she finishes speaking. Same last speaker can continue without the wake word. 0 or unset = 25000. -1 = STRICT (name required every turn).', default: 25000 },
      voice_drone: { type: 'boolean', title: 'Voice: play a soft ambient drone while processing a spoken reply', default: true },
      voice_post_transcript: { type: 'boolean', title: 'Voice: post the live transcript (🗣️ lines) into the text channel as people speak (off = no per-utterance flood)', default: true },
      voice_barge_in: { type: 'boolean', title: 'Voice: barge-in — let someone interrupt a spoken reply by talking over it (off = quieter in noisy/cross-talk meetings)', default: true },
      voice_realtime: { type: 'boolean', title: 'Voice: realtime streaming transcription (server-VAD turn-taking + live captions) instead of batch-per-utterance', default: true },
      voice_transcript_file: { type: 'boolean', title: 'Voice: upload a full transcript .txt to the origin channel when leaving the voice channel', default: true },
      stream_steps: { type: 'boolean', title: 'Post sanitized 💭 thought chips when addressed. medium/high: 💭 only. xhigh: 💭 plus tool / Working chips. Never raw thoughts.', default: true },
      stream_tools: { type: 'boolean', title: 'When true, post a sanitized tool title (-# 🔧 `Read`) on start instead of the human chip. Default off. Never args/paths/updates.', default: false },
      ignore_other_mentions: { type: 'boolean', title: 'Do not REPLY to messages @-directed at other specific users/bots (still ingested for awareness)', default: true },
      ingest_unaddressed: { type: 'boolean', title: 'Ingest EVERY message in enabled channels into context (stay current on the whole conversation), replying only when addressed. False = only ingest what you might reply to.', default: true },
      channels_default: { type: 'boolean', title: 'Listen in channels by default (false = allowlist: ignore every channel except ones you enable)', default: true },
      pii_gate: { type: 'string', title: 'PII gate: off (default), classify_redact, or trust_store. Whole-reply drop is nuclear (whole_reply_drop).', enum: ['off', 'classify_redact', 'trust_store'], default: 'off' },
      whole_reply_drop: { type: 'boolean', title: 'Nuclear: drop the whole public reply on a PII hit. Default off. Prefer classify-then-redact.', default: false },
      attachments: { type: 'string', title: 'Inbound attachments: all_files (default) or media_only (image/video only).', enum: ['all_files', 'media_only'], default: 'all_files' },
      thought_chips: { type: 'string', title: 'Thought chips: off (default), smart (sanitized), or raw.', enum: ['off', 'smart', 'raw'], default: 'off' },
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
  const piiGate = String(cfg.pii_gate || 'off');
  const wholeReplyDrop = !!cfg.whole_reply_drop;
  const attachmentsMode = String(cfg.attachments || 'all_files');
  const thoughtChips = String(cfg.thought_chips || (cfg.stream_steps === false ? 'off' : (cfg.stream_steps ? 'smart' : 'off')));
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

  // channel aliases for unified outbound (alias → channel id)
  let aliases = {};
  try { aliases = JSON.parse(fs.readFileSync(cfg.aliases_file || path.join(__dirname, 'channel-aliases.json'), 'utf8')).aliases || {}; } catch (_) {}
  const resolveChannel = (t) => aliases[t] || t;

  // --- state ---
  let memory = { servers: {}, globalTimeline: [] };
  const processing = new Map();
  function abortTarget(cid, starterId, kind) {
    if (cid == null || cid === '') return null;
    const id = String(cid);
    if (!processing.has(id)) processing.set(id, { starterId: String(starterId || ''), kind: kind || 'turn' });
    return processing.get(id);
  }
  function releaseAbortTarget(cid, kind) {
    if (cid == null || cid === '') return;
    const id = String(cid);
    const slot = processing.get(id);
    if (slot && (!kind || slot.kind === kind)) processing.delete(id);
  }
  const lateMedia = new Map(); // cid -> message (same-author upload during a turn; run after)
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
  let transcriptOffChannels = new Set();
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    (s.mutedChannels || []).forEach((c) => channelStates.set(String(c), false)); // migrate legacy mutes
    if (s.channels && typeof s.channels === 'object') for (const [c, on] of Object.entries(s.channels)) channelStates.set(String(c), !!on);
    if (typeof s.channelsDefault === 'boolean') channelsDefault = s.channelsDefault;
    engageAllBots = !!s.engageAllBots;
    transcriptOffChannels = loadTranscriptOff(s.transcriptOffChannels);
  } catch (_) {}
  function channelEnabled(cid) { return channelStates.has(String(cid)) ? channelStates.get(String(cid)) : channelsDefault; }
  function saveSettings() {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify({ channels: Object.fromEntries(channelStates), channelsDefault, engageAllBots, transcriptOffChannels: serializeTranscriptOff(transcriptOffChannels) })); }
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
      crossContext: crossContextForPrompt(),
      location: { serverName: memory.servers[sid]?.name || 'Direct Message', channelName: memory.servers[sid]?.channels[cid]?.name || 'DM', participants: Array.from(memory.servers[sid]?.channels[cid]?.participants || []) },
    };
  }

  // --- autonomous participation (verbatim heuristics) ---
  function shouldRespondTo(message) {
    if (message.channel.type === 1) return message.author.id === dmUser; // DM: only the owner
    if (message.mentions.has(client.user)) return true;
    if (isReplyToUs(message, client.user && client.user.id)) return true;
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

  // The conversation_key the core uses for this message's session (MUST match the envelope's key so
  // /v2/inject and /v2/abort target the right running turn).
  function convKeyFor(message) {
    return message.guild?.id
      ? `discord:${ctx.instanceId}:channel:${message.channel.id}`
      : `discord:${ctx.instanceId}:dm:${message.author.id}`;
  }
  // Is this bot directly addressed? @-mention, DM, a role it holds, or the caller forced it.
  function isAddressed(message, forced) {
    if (forced || message.channel.type === 1) return true;
    if (message.mentions.has(client.user)) return true;
    if (isReplyToUs(message, client.user && client.user.id)) return true;
    const botMember = message.guild ? (message.guild.members.me || message.guild.members.cache.get(client.user.id)) : null;
    return !!botMember && message.mentions.roles.some((r) => botMember.roles.cache.has(r.id));
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
    if (isTranscriptOffCmd(cmd)) {
      setTranscriptOff(transcriptOffChannels, cid, true);
      if (message.guild) {
        for (const och of voiceText.values()) {
          if (och && och.guild && String(och.guild.id) === String(message.guild.id) && och.id) {
            setTranscriptOff(transcriptOffChannels, och.id, true);
          }
        }
      }
      saveSettings();
      ctx.log('[voice] scribe-off cid=' + cid);
      await message.channel.send(`🔕 Live transcript **off** in this channel — I'll stay quiet here until \`@${me} scribe-on\`.`); return true;
    }
    if (isTranscriptOnCmd(cmd)) {
      setTranscriptOff(transcriptOffChannels, cid, false);
      if (message.guild) {
        for (const och of voiceText.values()) {
          if (och && och.guild && String(och.guild.id) === String(message.guild.id) && och.id) {
            setTranscriptOff(transcriptOffChannels, och.id, false);
          }
        }
      }
      saveSettings();
      ctx.log('[voice] scribe-on cid=' + cid);
      await message.channel.send('📝 Live transcript **on** — I\'ll post 🗣️ lines as people speak.'); return true;
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
      // transcript on/off handled above (per-channel persist via isTranscriptOffCmd / isTranscriptOnCmd)
      case 'join-voice': case 'join voice': case 'join vc': case 'join the voice':
        await doJoinVoice(message); return true;
      case 'update-asmltr': case 'update asmltr': case 'self-update': case 'update yourself':
        await doUpdateAsmltr(message); return true;
      case 'leave-voice': case 'leave voice': case 'leave vc': case 'leave the voice':
        await doLeaveVoice(message); return true;
      case 'stop': case 'cancel': case 'abort': case 'halt': {
        // Interrupt the running turn for THIS channel AND fan the stop through to a live voice session
        // joined from this channel (#138). Public: anyone may stop a processing turn (humans always win).
        // Public anyone-can-stop. Overlay wrapAbortRoute on core /v2/abort keeps host starter-or-owner. Do not put stop in OWNER_ONLY_CMDS.
        // Session survives; next message continues it.
        const slot = processing.get(cid);
        const gid = message.guild?.id;
        let voice; try { voice = require('./voice'); } catch (_) {}
        const originCh = gid ? voiceText.get(gid) : null;
        const voiceHere = !!(gid && voice && voice.isConnected(gid) && (!originCh || originCh.id === message.channel.id));
        let starterId = null;
        let owner = false;
        if (slot) {
          starterId = abortAllow.starterIdFromSlot(slot);
          owner = await isOwner(message);
          if (!abortAllow.canAbortTurn({ isOwner: owner, authorId: message.author.id, starterId })) {
            await message.react('🙅').catch(() => {});
            await message.channel.send('Only the person who started this turn (or my owner) can stop it.').catch(() => {});
            return true;
          }
        } else if (!voiceHere) {
          await message.react('🤷').catch(() => {});
          return true;
        }
        let acted = false;
        if (voiceHere) { const s = await stopVoiceReply(gid, { chime: false }); acted = acted || s; }
        if (slot) {
          try {
            await ctx.core.abort(convKeyFor(message), {
              speakerId: String(message.author.id),
              starterId: starterId || undefined,
              ownerId: owner ? String(message.author.id) : 'owner',
            });
            acted = true;
          }
          catch (e) { ctx.log('abort failed: ' + e.message); await message.channel.send('⚠ Couldn\'t stop the current turn.'); }
        }
        await message.react(acted ? '🛑' : '🤷').catch(() => {});
        return true;
      }
      case 'mute-voice': case 'mute voice': case 'voice-mute': {
        // Persistent voice mute from TEXT (P2 parity): keep transcribing, never speak, until unmuted.
        const gid = message.guild?.id;
        if (!gid) { await message.channel.send('That only applies in a server voice channel.'); return true; }
        voiceMuted.add(gid);
        let voice; try { voice = require('./voice'); } catch (_) {}
        if (voice && voice.isConnected(gid)) await stopVoiceReply(gid, { chime: false });
        await message.channel.send(`🔇 Voice muted — I'll keep transcribing but won't speak until \`@${me} unmute-voice\` (or say "${NAME}, unmute").`); return true;
      }
      case 'unmute-voice': case 'unmute voice': case 'voice-unmute': {
        const gid = message.guild?.id;
        if (gid) voiceMuted.delete(gid);
        await message.channel.send('🔊 Voice unmuted — I\'ll respond when addressed again.'); return true;
      }
      case 'status':
        await message.channel.send(`**Status:** ${silenced ? 'silenced (mention-only)' : 'active (autonomous)'}\n**Bots:** ${engageAllBots ? 'engaging ALL bots' : (allowedBotNames.length ? 'allowlist — ' + allowedBotNames.join(', ') : 'ignoring all bots')}\n**This channel:** ${channelEnabled(cid) ? 'enabled' : 'disabled'} (default: ${channelsDefault ? 'enabled' : 'disabled'})\n**Transcript:** ${isTranscriptOff(transcriptOffChannels, cid) ? 'off in this channel (`scribe-on` to restore)' : 'on in this channel (`scribe-off` to hide)'}`); return true;
      case 'help': case 'commands':
        await message.channel.send(`**Commands** — \`@${me} <command>\`:\n\`silence\` / \`speak\` · \`disable\` / \`enable\` (aka \`mute\`/\`unmute\`, this channel) · \`engage-all-bots\` / \`disengage-all-bots\` · \`join-voice\` / \`leave-voice\` · \`mute-voice\` / \`unmute-voice\` (stay in-call but silent) · \`drone-on\` / \`drone-off\` · \`scribe-on\` / \`scribe-off\` (this channel) · \`update-asmltr\` · \`status\` · \`stop\` (interrupt what I'm doing)\n_Tip: @-mention me again **while I'm working** to steer the running turn — your message folds into what I'm already doing, like typing mid-task._`); return true;
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
    const cross = crossContextBlock(context.crossContext);
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
4. If this message is not for you (see MULTI-AGENT CHANNEL), output ONLY the literal token ${NO_REPLY} and nothing else — do not explain, do not greet, just the token. Do NOT paraphrase it: writing "No response requested", "No reply needed", "N/A", or any prose instead of the exact token will get POSTED to the channel as spam. The verbatim token ${NO_REPLY} is the only way to stay silent.
5. Sparse color reaction (not every post): if THIS message is extra — extra funny, outrageous, a Homer d'oh / facepalm, genuinely wild, or a rare salute — you MAY add a single line \`[[REACT:😂]]\` using one of: 😂 🤣 💀 🤯 🫠 🤡 😳 🤦 😬 😅 🔥 🫡 🙌 💯 🤨 🙄. Do NOT react to ordinary chat. At most one. React and reply are NOT mutually exclusive: if the conversation is ongoing, react AND write the reply (REACT line + your text). If there is really nothing else to say, react-only is enough (REACT line, and ${NO_REPLY} so no message posts). Never use 👀 (mid-turn steer) or 🛑 (stop).
${referentPromptBlock()}`;
  }

  // Subdued Discord line helper. Tool chips are built in shared/step-public (not raw thoughts).
  const streamSteps = thoughtChips === 'smart' || thoughtChips === 'raw' || (thoughtChips !== 'off' && cfg.stream_steps !== false);
  const streamTools = cfg.stream_tools === true;
  function renderStep(t) {
    const clamped = t.length > 700 ? t.slice(0, 700) + '…' : t;
    return clamped.split('\n').map(l => '-# ' + (l.trim() ? l : '​')).join('\n').slice(0, 1900);
  }

  async function persistInboundMedia(message, conversationKey) {
    const inboundMedia = require('../../../shared/inbound-media');
    const imageAttachments = [];
    const mediaFiles = [];
    const savedNotes = [];
    if (!message || !message.attachments || message.attachments.size === 0) {
      return { imageAttachments, mediaFiles, savedNotes };
    }
    for (const a of message.attachments.values()) {
      const mt = (a.contentType || '').split(';')[0].trim();
      const claimed = Number(a.size) || 0;
      if (claimed > inboundMedia.MAX_VIDEO) {
        savedNotes.push(`- ignored ${a.name}: too large`);
        continue;
      }
      try {
        const buf = Buffer.from(await (await fetch(a.url)).arrayBuffer());
        const cls = inboundMedia.classify(buf, mt, a.name);
        if (!cls.kind) {
          if (attachmentsMode === 'media_only') {
            savedNotes.push(`- ignored ${a.name} (${mt || 'unknown'}): not a still image or video — not opened`);
            continue;
          }
          savedNotes.push(`- file: ${a.name} (${mt || 'unknown'}) — stored, not executed`);
          continue;
        }
        const saved = inboundMedia.saveRef(buf, { name: a.name, mime: mt });
        if (!saved.ok) {
          savedNotes.push(`- ignored ${a.name}: ${saved.error}`);
          continue;
        }
        try {
          ctx.uploads.save({
            channel: 'discord', instance: ctx.instanceId, buffer: buf,
            filename: a.name, mime: saved.mime, kind: saved.kind,
            caption: message.content || '', sender: message.author && message.author.username, senderId: message.author && message.author.id,
            conversationKey,
          });
        } catch (e) { ctx.log(`[upload] register failed ${a.name}: ${e.message}`); }
        mediaFiles.push({ kind: saved.kind, path: saved.path, mime: saved.mime, name: saved.name });
        if (saved.kind === 'image' && imageAttachments.length < 5) {
          imageAttachments.push({ type: 'image', media_type: saved.mime, data: buf.toString('base64'), name: a.name, path: saved.path });
        }
        savedNotes.push(`- ${saved.kind}: ${saved.name} (generation reference; do not execute)`);
      } catch (e) {
        ctx.log(`[att] download failed ${a.name}: ${e.message}`);
        savedNotes.push(`- ${a.name}: could not download`);
      }
    }
    return { imageAttachments, mediaFiles, savedNotes };
  }

  async function handleMessage(message, forced) {
    const cid = message.channel.id;
    if (processing.get(cid)) {
      // A turn is already running in this channel. If THIS message is addressed to us, queue it into the
      // running turn as steering guidance (like typing in the Claude TUI mid-run) — don't drop it, and
      // don't start a concurrent turn. The core folds it into the work in progress and continues; its
      // reply comes back out to the channel via the stored outbound route. Non-addressed chatter is still
      // ignored so idle channel noise can't derail the work. (`@handle stop` interrupts — handled earlier.)
      // Same-author uploads during the turn are SAVED (so "look up" can find them) and run as their
      // own turn after this one — not a look-ahead wait. Bystander attachments are not persisted
      // into this conversation's uploads while the lock is held.
      const slot = processing.get(cid);
      if (shouldQueueLateMedia(slot, message)) {
        try { await persistInboundMedia(message, convKeyFor(message)); }
        catch (e) { ctx.log('late media save failed: ' + e.message); }
        lateMedia.set(cid, message);
      }
      if (isAddressed(message, forced)) {
        const guidance = String(message.content || '').replace(/<@[!&]?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (guidance) {
          const by = injectBy(await isOwner(message), message.author.id);
          abortTarget(cid, message.author.id, 'inject');
          ctx.core.inject(convKeyFor(message), guidance, { by, interrupt: false })
            .then(() => message.react('👀').catch(() => {}))
            .catch((e) => ctx.log('mid-turn steer failed: ' + e.message));
        }
      }
      return;
    }
    abortTarget(cid, message.author.id, 'stream');
    // Discord's typing indicator auto-expires after ~10s. Re-trigger it every
    // 8s so the "…is typing" shows for the ENTIRE (possibly multi-minute)
    // processing time, not just the first few seconds. Cleared in finally.
    let typingInterval = null;
    let stopBeat = () => {};
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
      // Image/video only. Magic bytes win. Never persist or open exe/html/js/pdf/zip.
      // If this message has no still but replies to one, that still IS the referent — pull it in.
      let mediaSource = message;
      if ((!message.attachments || message.attachments.size === 0) && message.reference) {
        const ref = await message.fetchReference().catch(() => null);
        if (ref && ref.attachments && ref.attachments.size > 0) mediaSource = ref;
      }
      const persisted = await persistInboundMedia(mediaSource, conversationKey);
      const imageAttachments = persisted.imageAttachments;
      const mediaFiles = persisted.mediaFiles;
      if (persisted.savedNotes.length) {
        const viaReply = mediaSource !== message ? ' (from the message this replies to)' : '';
        text += '\n\nCHANNEL MEDIA' + viaReply + ':\n' + persisted.savedNotes.join('\n');
      }
      // server + channel names ride in channel_context → the core records them on the inbound
      // event (and the collector stores them on the session) so the dashboard shows where a
      // conversation is happening. (No separate inbound emit here — the core records inbound.)
      const envelope = {
        channel: 'discord',
        conversation_key: conversationKey,
        message_id: String(message.id),
        sender: { raw_id: String(message.author.id), raw_username: message.author.username },
        content: { text, attachments: imageAttachments, media_files: mediaFiles },
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
      let leakDropped = false;
      let actions = [];
      const hints = speakerHintsFrom(message.author, message.member);
      const hintKinds = mergeSpeakerLastNames(new Map(), message.author, message.member);
      const blockHints = publicBlockHints(hints, hintKinds);
      if (streamSteps && addressed) {
        // Hold the latest narration block in `pending`; flush it as a live step the moment its
        // boundary closes — either a tool call starts (the common case: post immediately, no lag)
        // or a new narration block begins. The block still open at `done` is the final answer.
        let pending = '', sawNoReply = false, chain = Promise.resolve(), lastChip = '';
        let beatTimer = null;
        // Image gen: core classifies first. No chips until effort.imageGen (or image_gen tool).
        let quietImageGen = false;
        let maxThoughts = thoughtBudget('medium');
        let thoughtsPosted = 0;
        const enqueue = (fn) => { chain = chain.then(fn).catch(() => {}); };
        stopBeat = () => { if (beatTimer) { clearTimeout(beatTimer); beatTimer = null; } };
        const armBeat = () => {
          if (quietImageGen || maxThoughts !== Infinity) return; // medium/high/image-gen: no Still working
          stopBeat();
          beatTimer = setTimeout(() => {
            beatTimer = null;
            if (sawNoReply) return;
            lastChip = STILL_WORKING_LINE;
            enqueue(() => message.channel.send(STILL_WORKING_LINE));
            armBeat();
          }, THINK_HEARTBEAT_MS);
        };
        const postChip = (line) => {
          if (!line || line === lastChip) return false;
          lastChip = line;
          enqueue(() => message.channel.send(line));
          armBeat();
          return true;
        };
        const enterImageGenQuiet = () => {
          quietImageGen = true;
          maxThoughts = 0;
          stopBeat();
          postChip(GENERATING_LINE);
        };
        const holdAnswer = (t) => {
          const clean = String(t || '').trim();
          if (!clean) { pending = ''; return; }
          if (isSilence(clean)) { sawNoReply = true; pending = ''; stopBeat(); return; }
          if (looksLikePromptRestatement(clean) || (envelope.public && wholeReplyDrop && piiGate !== 'off' && privacyHitKind(clean, hints, hintKinds))) {
            pending = '';
            leakDropped = true;
            return;
          }
          leakDropped = false;
          pending = t;
        };
        actions = await ctx.core.handleStream(envelope, {
          onEffort: (effort, meta) => {
            if (meta && meta.imageGen) {
              enterImageGenQuiet();
              return;
            }
            maxThoughts = thoughtBudget(effort, { imageGen: quietImageGen });
          },
          onSegment: (t) => { holdAnswer(t); },
          onTool: (tool) => {
            pending = '';
            if (sawNoReply) return;
            if (isImageGenTool(tool)) {
              enterImageGenQuiet();
              return;
            }
            if (quietImageGen) return;
            if (maxThoughts !== Infinity) return; // not xhigh: 💭 only, no tooling
            const line = discordToolLine(streamTools, tool);
            if (!line) return;
            postChip(line);
          },
          // Engine-agnostic: Claude/Grok/Gemini/Codex all use onThinking. No-op if none.
          onThinking: (t) => {
            if (sawNoReply) return;
            if (quietImageGen || maxThoughts <= 0) return;
            const line = discordThoughtLine(t, hints, hintKinds);
            if (line && thoughtsPosted < maxThoughts) {
              thoughtsPosted += 1;
              postChip(line);
              return;
            }
            if (maxThoughts !== Infinity) return; // no Working filler on medium/high
            if (!lastChip) postChip(WORKING_LINE);
            else if (!beatTimer) armBeat();
          },
        });
        stopBeat();
        await chain; // all step messages posted before the final answer
        const reply = actions.find(a => a.type === 'reply');
        replyText = pickPublicReply({
          pending,
          replyText: reply ? reply.text.trim() : '',
          leakDropped,
          publicSurface: !!envelope.public && piiGate !== 'off' && wholeReplyDrop,
          hints,
          hintKinds,
        });
      } else {
        actions = await ctx.core.handle(envelope);
        const reply = actions.find(a => a.type === 'reply');
        replyText = pickPublicReply({
          pending: '',
          replyText: reply ? reply.text.trim() : '',
          leakDropped: false,
          publicSurface: !!envelope.public && piiGate !== 'off' && wholeReplyDrop,
          hints,
          hintKinds,
        });
      }
      const color = parseReact(replyText);
      replyText = color.text;
      const fromCore = actions.find((a) => a && a.type === 'react');
      const reactEmoji = color.emoji || (fromCore && fromCore.emoji) || '';
      if (reactEmoji) await message.react(reactEmoji).catch((e) => ctx.log('react failed: ' + e.message));
      // Self-gated suppression: the model decided this message wasn't for it (multi-agent
      // channel), or there's nothing to say. Drop it — don't post to the channel.
      if (isSilence(replyText)) { ctx.log(`suppressed reply (not addressed to ${NAME})`); return; }
      // Dedup: never re-post a message verbatim-identical to one of the last few we sent here.
      // Long resumed sessions (esp. AI-to-AI loops) can occasionally replay an earlier reply.
      const recents = recentReplies.get(cid) || [];
      if (recents.includes(replyText)) { ctx.log('suppressed duplicate reply (verbatim repeat of a recent message)'); return; }
      recents.push(replyText); if (recents.length > 6) recents.shift(); recentReplies.set(cid, recents);
      for (const chunk of splitResponse(replyText)) await message.channel.send(chunk);
      saveMemory(message, NAME, replyText);
      lastResponseTime = Date.now();
      responseCount.set(cid, (responseCount.get(cid) || 0) + 1);
      setTimeout(() => responseCount.set(cid, Math.max(0, (responseCount.get(cid) || 0) - 1)), 3600000);
    } catch (e) {
      ctx.log('handle error: ' + e.message);
      await message.channel.send('⚠️ I hit an error processing that. Recalibrating...').catch(() => {});
    } finally {
      try { stopBeat(); } catch (_) {}
      if (typingInterval) clearInterval(typingInterval);
      processing.delete(cid);
      const queued = lateMedia.get(cid);
      if (queued) {
        lateMedia.delete(cid);
        setImmediate(() => {
          handleMessage(queued, true).catch((e) => ctx.log('late media turn failed: ' + e.message));
        });
      }
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
    // Unified STT through the pluggable voice-engine ROLE layer (#113/#139): resolve the engine bound to
    // `transcribe` instead of hard-wiring a model, so a Settings change swaps Discord's STT with no code edit.
    // NO name-priming prompt: it both biased the decoder toward mis-hearing the wake word AND got echoed
    // into transcripts on near-silent audio (#137). We recover recognition via a confidence gate instead.
    const language = cfg.stt_language === undefined ? 'en' : cfg.stt_language;
    // Use the role-bound engine's model ONLY when it's a plain OpenAI transcribe model. The per-utterance
    // clip path uses transcribe() (json+logprobs); the diarize model needs the diarized_json shape and a
    // single-speaker command clip doesn't need diarization anyway → fall back to the STT config default.
    let model;
    try {
      const cap = voiceEngines.resolve('transcribe').capabilities;
      if (cap && cap.provider === 'openai' && cap.model && !/diarize/i.test(cap.model)) model = cap.model;
    } catch (_) {}
    const out = await sharedStt.transcribe(wav, {
      mime: 'audio/wav', filename: 'utt.wav', language, model, logprobs: true,
    });
    // Aux cost: STT runs on a metered key. Price by audio seconds (est. from clip size when the model
    // doesn't report duration) so the Discord voice bridge's transcription cost lands in the Billed total.
    const seconds = out.duration || estimateAudioSeconds(out.bytes, 'audio/wav');
    ctx.emit(auxUsage({ surface: 'discord', feature: 'stt', provider: 'openai', model: out.model, seconds }));
    return { text: out.text || '', confidence: out.confidence };
  }

  // --- gatekeeper: does this spoken utterance ADDRESS the assistant? --------------------------
  // Delegates to the SHARED wake matcher (shared/speech/wake) so Discord, the app, and the PWA agree.
  // `addressesName` is the pure "is it addressed?" test (used by leave/dismiss checks). The FIRE decision
  // (does it dispatch a turn?) goes through `wakeDecision`, which adds the confidence gate that kills the
  // false-"<name>" trigger (#136): a fuzzy STT artifact that merely looks like the name won't respond.
  function addressesName(text) { return sharedWake.addresses(text, NAME); }
  function wakeDecision(text, confidence) {
    const sensitivity = sharedStt.config().wake_sensitivity;
    return sharedWake.evaluate({ text, wakeWord: NAME, sensitivity, confidence });
  }

  const VOICE_GUIDANCE = [
    'You are in a LIVE Discord voice meeting and your reply will be spoken aloud via text-to-speech.',
    'Keep it short and natural — 1 to 3 sentences. No markdown, no bullet lists, no code blocks, no emoji, no URLs read out.',
    'Do not use tools. Reply from what you already know. Keep the SPOKEN answer brief and conversational.',
  ].join(' ');
  const VOICE_GUIDANCE_LIVE = [
    'You are in a LIVE Discord voice meeting and your reply will be spoken aloud.',
    'Keep it short and natural — 1 to 3 sentences. No markdown, no bullet lists, no code blocks, no emoji, no URLs read out.',
    'Call asmltr function tools when the speaker is trusted; if a tool is denied, say so briefly. Keep the SPOKEN answer brief and conversational.',
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
      // Aux cost: ElevenLabs is a metered key → record the synthesized characters for the Billed total.
      ctx.emit(auxUsage({ surface: 'discord', feature: 'tts', provider: 'elevenlabs',
        model: cfg.tts_model || 'eleven_turbo_v2_5', chars: text.length }));
      return audio;
    } catch (e) { ctx.log(`[voice] tts failed: ${e.message}`); return null; }
  }

  const voiceBusy = new Set();   // guildIds mid-reply (one spoken reply at a time)
  const voiceActive = new Map(); // guildId -> { expires, userId } last-speaker follow-up window
  const voiceReplyStart = new Map(); // guildId -> ts first spoken audio started (barge-in grace window)
  const BARGE_GRACE_MS = 1200;   // ignore barge-in this long after first spoken audio (don't cut off on the asker's own trailing words)
  const BARGE_MIN_SPEECH_MS = 3000; // continuous human talk-over before barge; sneeze/one word must not dump her
  const voiceOverlapArm = new Map();   // guildId -> overlap start ts
  const voiceOverlapTimer = new Map(); // guildId -> pending barge check
  const voiceMuted = new Set();  // guildIds where Eve is MUTED in-voice: keeps transcribing, but never speaks/replies until unmuted (P2)
  const voiceGen = new Map();    // guildId -> reply generation. stopVoiceReply bumps it; the in-flight reply checks it and bails, so a stopped turn never speaks even if the LLM finishes after the abort.
  // missing/0 = 25s same-speaker follow-up after she talks. -1/false = STRICT (name every turn).
  const VOICE_WINDOW_MS = resolveVoiceFollowupMs(cfg.voice_followup_ms);
  let voiceDrone = cfg.voice_drone !== false; // ambient "working" drone during a spoken reply (toggleable)
  const voicePostTranscript = cfg.voice_post_transcript !== false; // live 🗣️ default; per-channel scribe-off wins
  const voiceTranscriptFile = cfg.voice_transcript_file !== false; // upload a full transcript .txt on leave
  const voiceLog = new Map(); // guildId -> [{ t, who, text }] accumulated for the whole voice session
  const converseSessions = new Map(); // guildId -> converse-grok session (Live)
  const converseSpeaker = new Map(); // guildId -> { userId, name }
  const pcmRing = new Map(); // `${guildId}:${userId}` -> Buffer[] last ~4s
  const pcmTurnLogged = new Set();
  const pcmTurnAt = new Map();
  const forceTurnAt = new Map();
  const PCM_RING_BYTES = 48000 * 2 * 4;

  function countHumansNow(guildId) {
    // Cache/members miss → treat as group (2), never fake 1:1.
    // Returning 1 here would shouldForceTurn every speaking-stop while the
    // Discord member list is still empty, so a group got answered as solo.
    try {
      const voice = require('./voice');
      const cid = voice.channelIdOf && voice.channelIdOf(guildId);
      if (!cid) return 2;
      const ch = client.channels.cache && client.channels.cache.get(cid);
      if (!ch || ch.members == null) return 2;
      const selfId = client.user && client.user.id;
      const n = countHumans(ch, selfId);
      if (n === 0) return 2;
      return n;
    } catch (_) { return 2; }
  }
  function liveRoomLine(guildId) {
    const conv = converseSessions.get(guildId);
    const base = roomInstructions(countHumansNow(guildId));
    if (conv && conv._skipNoted) return base + ' ' + roomSkipNote();
    return base;
  }

  function mouthBusy(guildId) {
    const vMouth = require('./voice');
    return voiceBusy.has(guildId) || !!(vMouth.isMouthPlaying && vMouth.isMouthPlaying(guildId));
  }

  // After greet/pacer idle: one response.create for speech that arrived during the greet.
  function flushDeferredCreate(guildId) {
    const c = converseSessions.get(guildId);
    if (!c || typeof c.createResponse !== 'function') return;
    if (c._responseOpen || mouthBusy(guildId)) return;
    if (!c._pendingFirst) return;
    if (c._skipNextCreate) {
      c._skipNextCreate = false;
      c._pendingFirst = null;
      ctx.log('[voice] pending first dropped (stop/hold)');
      return;
    }
    const speakerId = (c._pendingFirst && c._pendingFirst.userId) || (converseSpeaker.get(guildId) || {}).userId;
    c._pendingFirst = null;
    c._awaitFirstUser = false;
    c._lastAnsweredId = speakerId ? String(speakerId) : c._lastAnsweredId;
    c._responseOpen = true;
    try {
      c.createResponse();
      ctx.log('[voice] first-utterance after greet → response.create');
    } catch (e) {
      c._responseOpen = false;
      ctx.log('[voice] createResponse: ' + e.message);
    }
  }

  function clearVoiceOverlap(guildId) {
    voiceOverlapArm.delete(guildId);
    const t = voiceOverlapTimer.get(guildId);
    if (t) clearTimeout(t);
    voiceOverlapTimer.delete(guildId);
  }

  function armVoiceOverlap(guildId, { live } = {}) {
    if (cfg.voice_barge_in === false) return;
    if (!voiceOverlapArm.has(guildId)) voiceOverlapArm.set(guildId, Date.now());
    if (voiceOverlapTimer.has(guildId)) return;
    const tick = () => {
      voiceOverlapTimer.delete(guildId);
      if (!voiceOverlapArm.has(guildId)) return;
      let v;
      try { v = require('./voice'); } catch (_) { return; }
      const now = Date.now();
      const arm = voiceOverlapArm.get(guildId);
      if (!shouldBargeIn({
        busy: voiceBusy.has(guildId),
        speaking: v.isSpeaking(guildId),
        replyStartedAt: voiceReplyStart.get(guildId),
        now,
        graceMs: BARGE_GRACE_MS,
        userSpeechMs: now - arm,
        minSpeechMs: BARGE_MIN_SPEECH_MS,
      })) {
        if (!voiceBusy.has(guildId)) return;
        const started = voiceReplyStart.get(guildId);
        const needSpeech = BARGE_MIN_SPEECH_MS - (now - arm);
        const needGrace = started == null ? 80 : BARGE_GRACE_MS - (now - started);
        const wait = Math.max(needSpeech, needGrace, 0);
        if (wait > 0) voiceOverlapTimer.set(guildId, setTimeout(tick, wait));
        return;
      }
      const ms = now - arm;
      ctx.log('[voice] overlap ' + ms + 'ms → 3s cancel (drop pacer + player.stop + response.cancel)');
      stopVoiceReply(guildId, { chime: false, barge: true });
      if (live) {
        const conv = converseSessions.get(guildId);
        if (conv) { try { conv.cancel(); } catch (_) {} }
      }
    };
    const now = Date.now();
    const arm = voiceOverlapArm.get(guildId);
    const started = voiceReplyStart.get(guildId);
    const needSpeech = BARGE_MIN_SPEECH_MS - (now - arm);
    const needGrace = started == null ? BARGE_MIN_SPEECH_MS : BARGE_GRACE_MS - (now - started);
    voiceOverlapTimer.set(guildId, setTimeout(tick, Math.max(needSpeech, needGrace, 0)));
  }

  function closeConverse(guildId) {
    clearVoiceOverlap(guildId);
    const conv = converseSessions.get(guildId);
    converseSessions.delete(guildId);
    converseSpeaker.delete(guildId);
    for (const k of [...pcmRing.keys()]) { if (k.startsWith(String(guildId) + ':')) pcmRing.delete(k); }
    if (conv) { try { conv._leave = true; conv.close(); } catch (_) {} }
    try { require('./voice').endPcmPlayback(guildId, { hard: true }); } catch (_) {}
  }

  function lastSpeakerId(guildId) {
    return lastSpeakerFromWindow({
      window: voiceActive.get(guildId),
      now: Date.now(),
      converseBound: converseSessions.has(guildId),
    });
  }

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
    if (!ch || !arr || !arr.length) return;
    if (!shouldUploadLeaveFile({ offSet: transcriptOffChannels, cid: ch.id, instanceDefault: voiceTranscriptFile })) return;
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
  const VOICE_STOP_RE = /\b(stop|cancel|hush|shush|be quiet|shut up|enough|nevermind|never mind|hold on|wait)\b/;
  // Persistent voice mute (P2) — distinct from the transient STOP. Explicit "mute" intent so it doesn't
  // collide with "stop". UNMUTE is checked first ("unmute" has no \bmute\b boundary, but be safe).
  const VOICE_MUTE_RE = /\b(mute( yourself| your ?self| voice)?|stay (quiet|muted)|keep quiet|go silent|silence yourself|zip it)\b/;
  const VOICE_UNMUTE_RE = /\b(un-?mute|you can (talk|speak)( again)?|start talking( again)?|come back|resume talking)\b/;

  // The conversation_key a spoken reply runs under (must match handleVoiceUtterance's handleStream call).
  const voiceConvKey = (guildId) => `discord-voice:${ctx.instanceId}:guild:${guildId}`;

  // ONE hard-stop primitive behind spoken-"stop", barge-in, and text `@bot stop` fan-out (#138): cancel
  // playback + queued sentences, kill the drone, abort the in-flight core turn, free the busy latch.
  async function stopVoiceReply(guildId, { chime = false, barge = false } = {}) {
    let voice; try { voice = require('./voice'); } catch (_) { return false; }
    const wasBusy = voiceBusy.has(guildId);
    voiceGen.set(guildId, (voiceGen.get(guildId) || 0) + 1); // invalidate the in-flight reply so it can't speak
    voice.stopSpeech(guildId); voice.stopDrone(guildId);
    try { voice.endPcmPlayback(guildId, { hard: true }); } catch (_) {}
    const convStop = converseSessions.get(guildId);
    if (convStop) {
      try { convStop.cancel(); } catch (_) {}
      // response.cancelled is not response.done — clear so the next idle turn can create.
      convStop._responseOpen = false;
      // Stop/hold: skip create on this utterance. After a 3s barge, speaking-stop
      // waits for transcript first (_bargeAwaitTranscript) so a real talk-over can still answer.
      convStop._skipNextCreate = true;
      if (barge) convStop._bargeAwaitTranscript = true;
    }
    voiceBusy.delete(guildId); voiceReplyStart.delete(guildId); clearVoiceOverlap(guildId);
    // After a real barge, resume uplink with the talk-through PCM sitting in pcmRing.
    if (barge && convStop) {
      const sp = converseSpeaker.get(guildId);
      if (sp && sp.userId) {
        const ringKey = guildId + ':' + sp.userId;
        const ring = pcmRing.get(ringKey);
        pcmRing.delete(ringKey);
        if (ring && ring.length) { try { convStop.pushPcm24(Buffer.concat(ring)); } catch (_) {} }
      }
    }
    try { await ctx.core.abort(voiceConvKey(guildId)); } catch (_) {}
    setVoiceStatus(null);
    if (chime && wasBusy) { try { await voice.playChime(guildId); } catch (_) {} }
    return wasBusy;
  }

  // Live streaming captions (realtime mode): one editable message per speaker that grows as they talk,
  // then becomes the final transcript. Edits are throttled so we stay well under Discord's rate limits.
  const liveCaptions = new Map(); // `${guildId}:${name}` -> { msg, lastEdit, pending, sending }
  const CAPTION_THROTTLE_MS = 1400;
  async function onVoicePartial(guildId, name, text) {
    if (!text) return;
    const ch = voiceText.get(guildId); if (!ch) return;
    if (!shouldPostLive({ offSet: transcriptOffChannels, cid: ch.id, instanceDefault: voicePostTranscript })) return;
    const key = `${guildId}:${name}`;
    let cap = liveCaptions.get(key);
    if (!cap) {
      cap = { msg: null, lastEdit: Date.now(), pending: text, sending: true };
      liveCaptions.set(key, cap);
      try { cap.msg = await ch.send(`🎙️ **${name}:** ${text}…`); } catch (_) {}
      cap.sending = false;
      return;
    }
    cap.pending = text;
    if (cap.sending || (Date.now() - cap.lastEdit) < CAPTION_THROTTLE_MS) return;
    cap.sending = true;
    try { if (cap.msg) await cap.msg.edit(`🎙️ **${name}:** ${cap.pending}…`); cap.lastEdit = Date.now(); } catch (_) {}
    cap.sending = false;
  }
  // Turn the live caption into the final transcript line (reuses the same message). Returns true if it did.
  function finalizeCaption(guildId, name, finalText) {
    const key = `${guildId}:${name}`;
    const cap = liveCaptions.get(key);
    if (!cap) return false;
    liveCaptions.delete(key);
    if (cap.msg) { cap.msg.edit(`🗣️ **${name}:** ${finalText}`).catch(() => {}); return true; }
    return false;
  }

  function upsertLiveUserLine(guildId, name, text, final) {
    const ch = voiceText.get(guildId);
    const line = String(text || '').slice(0, 1800);
    if (!line) return;
    if (final) logTranscript(guildId, name, line);
    if (!ch || !shouldPostLive({ offSet: transcriptOffChannels, cid: ch.id, instanceDefault: voicePostTranscript })) {
      ctx.log('[voice] 🗣️ skip (scribe off) cid=' + (ch && ch.id));
      return;
    }
    const key = `${guildId}:${name}`;
    const body = () => `🗣️ **${name}:** ${cap.pending}`;
    let cap = liveCaptions.get(key);
    const flush = () => {
      if (!cap.msg || cap.sending) return;
      if (cap.posted === cap.pending) {
        if (cap.done) liveCaptions.delete(key);
        return;
      }
      cap.sending = true;
      cap.msg.edit(body()).then(() => {
        cap.posted = cap.pending;
        cap.lastEdit = Date.now();
        cap.sending = false;
        if (cap.done) liveCaptions.delete(key);
        else if (cap.posted !== cap.pending) flush();
      }).catch(() => { cap.sending = false; });
    };
    if (!cap) {
      cap = { msg: null, lastEdit: Date.now(), pending: line, posted: '', sending: true, done: !!final };
      liveCaptions.set(key, cap);
      ch.send(`🗣️ **${name}:** ${line}`).then((m) => {
        cap.msg = m;
        cap.posted = line;
        cap.sending = false;
        if (cap.done && cap.posted === cap.pending) liveCaptions.delete(key);
        else flush();
      }).catch(() => { cap.sending = false; });
      return;
    }
    cap.pending = line;
    if (final) cap.done = true;
    flush();
  }

  // Called for EVERY transcribed utterance. Posts the live transcript, then decides if it's for
  // the assistant — addressed by name OR the SAME last speaker is inside the follow-up window
  // (so their next line needs no wake word). Other speakers still need the name. A dismissal
  // phrase exits answering mode back to transcription-only.
  async function handleVoiceUtterance(guildId, name, text, meta = {}) {
    const ch = voiceText.get(guildId);
    logTranscript(guildId, name, text); // always captured for the end-of-session file
    // Post the transcript line — in realtime mode, finalize the streaming caption into the final text
    // (one message per turn) instead of posting a duplicate line.
    if (!converseSessions.has(guildId) && ch && shouldPostLive({ offSet: transcriptOffChannels, cid: ch.id, instanceDefault: voicePostTranscript })) {
      if (!(meta.realtime && finalizeCaption(guildId, name, text))) ch.send(`🗣️ **${name}:** ${text}`).catch(() => {});
    }
    let voice; try { voice = require('./voice'); } catch (_) { return; }
    const lc = text.toLowerCase();
    const speakerId = meta.userId != null && meta.userId !== '' ? String(meta.userId) : '';
    const active = shouldAcceptFollowUp({ window: voiceActive.get(guildId), userId: speakerId, now: Date.now(), addressed: false, converseBound: converseSessions.has(guildId) });

    // SPOKEN STOP (#138) — highest priority, works mid-reply, before the busy latch. "<name>, stop"
    // (addressed + a stop word) or any configured stop phrase → hard-cancel whatever's speaking/generating.
    const stopPhrases = String(sharedStt.config().stop_phrases || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const isStop = (addressesName(text) && VOICE_STOP_RE.test(lc)) || stopPhrases.some((p) => p && lc.includes(p));
    if (isStop) {
      const stopped = await stopVoiceReply(guildId, { chime: true });
      voiceActive.delete(guildId);
      if (ch && stopped) ch.send('🛑 Stopped.').catch(() => {});
      return;
    }

    // Persistent voice MUTE / UNMUTE (P2) — spoken, addressed. Muted = keep transcribing but never reply
    // until unmuted (voice parity with the text disable). Check unmute first.
    if (addressesName(text)) {
      if (VOICE_UNMUTE_RE.test(lc)) {
        voiceMuted.delete(guildId);
        try { await voice.playChime(guildId); } catch (_) {}
        if (ch) ch.send(`🔊 Unmuted — I'll respond when addressed again.`).catch(() => {});
        return;
      }
      if (VOICE_MUTE_RE.test(lc)) {
        voiceMuted.add(guildId);
        await stopVoiceReply(guildId, { chime: false }); // silence anything mid-reply
        voiceActive.delete(guildId);
        if (ch) ch.send(`🔇 Muted — I'll keep transcribing but stay quiet until you say "${NAME}, unmute".`).catch(() => {});
        return;
      }
    }

    // spoken "leave voice" → actually disconnect from the voice channel
    if ((addressesName(text) || active) && LEAVE_RE.test(lc)) {
      voiceActive.delete(guildId); voiceText.delete(guildId); voiceMuted.delete(guildId); closeConverse(guildId); voice.leave(guildId); setVoiceStatus(null);
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

    // For me? Live: the model decides (1:1 = always; group = lean in when welcome). Flux path still uses
    // the follow-up window or the wake matcher, except 1:1 (just the owner) where every line is for her.
    const solo = countHumansNow(guildId) <= 1;
    if (!converseSessions.has(guildId) && !active && !solo) {
      const d = wakeDecision(text, meta.confidence);
      if (!d.addressed) {
        if (d.reason === 'low-confidence' || d.reason === 'bare-name-no-confidence-signal') {
          ctx.log(`[voice] wake REJECTED (${d.reason}; conf=${d.confidence == null ? 'n/a' : d.confidence}, thr=${d.threshold == null ? 'n/a' : d.threshold}): "${text.slice(0, 80)}"`);
        }
        return;
      }
      ctx.log(`[voice] wake fired (${d.reason}; conf=${d.confidence == null ? 'n/a' : d.confidence}): "${text.slice(0, 80)}"`);
    }

    if (voiceMuted.has(guildId)) {
      const convMuted = converseSessions.get(guildId);
      if (convMuted) { try { convMuted.cancel(); } catch (_) {} }
      return; // MUTED (P2): addressed, but stay quiet — transcript already posted
    }
    // Live: skip handleStream + ElevenLabs HTTP TTS; last-speaker PCM already on the converse WS.
    if (converseSessions.has(guildId)) {
      const next = armFollowUp({ now: Date.now(), windowMs: VOICE_WINDOW_MS, userId: speakerId });
      if (next) voiceActive.set(guildId, next);
      converseSpeaker.set(guildId, { userId: speakerId, name });
      pcmRing.delete(guildId + ':' + speakerId); // do not dump echo-contaminated ring into the WS on wake
      setVoiceStatus(`💭 ${String(text).slice(0, 40)}`);
      return;
    }
    if (voiceBusy.has(guildId)) return;  // don't stack replies
    // Immutable Discord user id is the trust key. A display-name fallback matches no mapping
    // and silently resolves to default / tier 0 — refuse the turn instead.
    const speakerId = meta.userId != null && meta.userId !== '' ? String(meta.userId) : '';
    if (!speakerId) {
      ctx.log(`[voice] skip turn: missing Discord userId (will not use display name as raw_id)`);
      return;
    }
    voiceBusy.add(guildId);
    const originCid = ch && ch.id;
    abortTarget(originCid, meta.userId || '', 'voice');
    voice.startSpeech(guildId);              // open a cancellable reply session (barge-in / stop can interrupt)
    const myGen = voiceGen.get(guildId) || 0; // this reply's generation; stopVoiceReply bumps it to cancel
    const live = () => (voiceGen.get(guildId) || 0) === myGen; // still the current, un-stopped reply?
    try {
      // Join-once chime lives in doJoinVoice. Already listening / still in the VC: no chime, no 600ms hole.
      if (shouldPlayWakeChime({ listening: voice.isListening(guildId), connected: voice.isConnected(guildId) })) {
        await voice.playChime(guildId);
        await new Promise((r) => setTimeout(r, 600));
      }
      setVoiceStatus(`💭 ${String(text).slice(0, 40)}`);
      if (voiceDrone) voice.startDrone(guildId); // soft "working on it" ambience (toggleable)

      // STREAM the reply: TTS + speak sentence-by-sentence as the answer generates, so long
      // answers start playing right away instead of after the whole thing is written. TTS runs
      // in parallel; playback is chained so sentences are spoken in order.
      let buf = '', full = '', firstAudio = false, chain = Promise.resolve();
      const speakSentence = (s) => {
        const t = s.trim(); if (!t || !live()) return; // stopped/superseded → don't even synthesize
        const ttsP = elevenLabsTTS(t);
        chain = chain.then(async () => {
          if (!live()) return;             // cancelled before this sentence's turn to play
          const mp3 = await ttsP;
          if (!mp3 || !live()) return;      // cancelled during TTS
          if (!firstAudio) { firstAudio = true; voice.stopDrone(guildId); setVoiceStatus('🔊 speaking'); voiceReplyStart.set(guildId, Date.now()); }
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
        // Identity = the SPEAKER who said her name. Pass their immutable Discord user ID as raw_id (same
        // key the text path uses) so the core resolves the RIGHT principal + trust per turn, instead of a
        // display name that matches no identity mapping (that's what made Eve address everyone as one person).
        sender: { raw_id: speakerId, raw_username: name },
        content: { text },
        delivery: 'sync',
        capabilities: { max_message_chars: 700, supports_markdown: false },
        public: true, // spoken into a room → redaction applies (never speak secrets aloud)
        system_prompt_extra: VOICE_GUIDANCE,
        context: { scope_id: `guild:${guildId}` },
        channel_context: { voice: true, speaker: name, guildId: String(guildId) },
      }, (delta) => { buf += delta; full += delta; flush(false); });
      flush(true);
      await chain; // wait until every sentence has finished speaking
      voice.stopDrone(guildId);
      // Only record/announce the reply if it wasn't stopped mid-flight (a cancelled turn never really spoke).
      if (full.trim() && live()) {
        logTranscript(guildId, NAME, full.trim());
        if (ch && shouldPostLive({ offSet: transcriptOffChannels, cid: ch.id, instanceDefault: voicePostTranscript })) ch.send(`🔊 **${NAME}:** ${full.trim().slice(0, 1800)}`).catch(() => {});
      }
      // Arm AFTER she actually finishes speaking (await chain = last speak() idle), last-speaker only.
      if (live() && firstAudio) {
        const next = armFollowUp({ now: Date.now(), windowMs: VOICE_WINDOW_MS, userId: speakerId });
        if (next) voiceActive.set(guildId, next);
      }
    } catch (e) { voice.stopDrone(guildId); ctx.log(`[voice] reply failed: ${e.message}`); if (ch) ch.send(`⚠️ voice reply failed: ${e.message}`).catch(() => {}); }
    finally { voice.endSpeech(guildId); voiceReplyStart.delete(guildId); voiceBusy.delete(guildId); clearVoiceOverlap(guildId); releaseAbortTarget(originCid, 'voice'); setVoiceStatus(null); } // back to listening/idle
  }

  // Voice commands: "the assistant, join" (joins the author's voice channel + chimes + listens) / "the assistant, leave".
  // All voice work is sandboxed so it can never crash the text presence.
  async function engineKeys() {
    const keys = {};
    try { keys.deepgram_api_key = !!(await ctx.secrets.get('deepgram_api_key')); } catch (_) { keys.deepgram_api_key = false; }
    try { keys.elevenlabs_api_key = !!(await ctx.secrets.get(cfg.elevenlabs_key_name || 'elevenlabs_api_key')); } catch (_) { keys.elevenlabs_api_key = false; }
    try {
      const data = await vault.getSecret('xai_voice_api_key', 'converse key present');
      keys.xai_voice_api_key = !!converseGrok.secretValue(data);
    } catch (_) { keys.xai_voice_api_key = false; }
    return keys;
  }

  async function realtimeListenConfig() {
    let rtModel = 'gpt-live-transcribe';
    let rtProvider = 'openai';
    let rtLive = true;
    try {
      const r = voiceEngines.resolve('realtime_transcribe', { keys: await engineKeys() });
      const c = r.capabilities;
      if (c && c.provider === 'deepgram') {
        rtProvider = 'deepgram';
        rtModel = c.model || 'flux-general-en';
        rtLive = true;
      } else if (c && c.provider === 'openai' && c.model && !/diarize/i.test(c.model)) {
        rtModel = c.model;
        rtLive = /live-transcribe/i.test(rtModel);
      }
    } catch (_) {}
    const vcfg = sharedStt.config();
    const vad = {
      endpointMs: Math.max(400, Math.min(4000, Number(vcfg.vad_endpoint_ms) || 1000)),
      rmsGate: Math.max(80, Math.round(600 - (Number(vcfg.vad_sensitivity) || 50) * 5)),
    };
    return { rtModel, rtLive, rtProvider, vad, realtime: cfg.voice_realtime !== false };
  }

  function refreshRoomInstructions(guildId) {
    const conv = converseSessions.get(guildId);
    if (!conv || typeof conv.update !== 'function') return;
    conv.update({ instructions: VOICE_GUIDANCE + '\n\n' + liveRoomLine(guildId) });
  }

  function runLiveFunction(guildId, conv, name, callId, args) {
    const sp = converseSpeaker.get(guildId) || {};
    const ch = voiceText.get(guildId);
    const envelope = liveTools.textEnvelope({
      instanceId: ctx.instanceId,
      guildId,
      channelId: ch && ch.id,
      userId: sp.userId,
      username: sp.name,
    });
    const turn = {
      channel: 'discord',
      guildId: String(guildId),
      sender: { raw_id: String(sp.userId || ''), raw_username: sp.name || '' },
      context: { scope_id: `guild:${guildId}` },
      conversation_key: envelope.conversation_key,
    };
    Promise.resolve()
      .then(async () => {
        let resolved = { is_default: true };
        try { resolved = (await ctx.core.resolve(envelope)) || resolved; } catch (_) {}
        return liveTools.executeFunctionCall({ name, args, resolved, envelope, turn });
      })
      .then((output) => { try { conv.sendFunctionOutput(callId, output); } catch (_) {} })
      .catch(() => { try { conv.sendFunctionOutput(callId, JSON.stringify({ ok: false, error: 'denied' })); } catch (_) {} });
  }

  function armLiveGreet(guildId) {
    const conv = converseSessions.get(guildId);
    if (!conv || conv._greeted || conv._leave || !conv._wantGreet) return;
    if (!conv._sessionUpdated) return;
    const voice = require('./voice');
    if (!voice.isListening(guildId) || !voice.isConnected(guildId)) return;
    conv._greeted = true;
    conv._awaitFirstUser = true;
    try { const greetName = (process.env.ASSISTANT_NAME || 'gaia').trim() || 'gaia'; conv.forceMessage(greetName + "'s here"); ctx.log('[voice] greet force_message (session.updated, listening)'); } catch (e) { ctx.log(`[voice] greet: ${e.message}`); }
  }

  async function tryOpenConverse(guildId, { greet } = { greet: true }) {
    let voiceKey = '';
    try {
      const data = await vault.getSecret('xai_voice_api_key', 'live converse');
      voiceKey = converseGrok.secretValue(data);
    } catch (_) { voiceKey = ''; }
    const r = voiceEngines.resolve('converse', { keys: { xai_voice_api_key: !!voiceKey } });
    if (!voiceKey || !r.engine_id || !voiceEngines.IMPLEMENTED.has(r.engine_id)) return null;
    let WS;
    try { WS = require('ws'); } catch (_) { WS = undefined; }
    let session;
    session = converseGrok.openSession({
      onOpen: () => ctx.log(`[voice] converse OPEN ${converseGrok.MODEL} voice=ara tools=[]`),
      onAudio: (pcm) => {
        if (voiceMuted.has(guildId)) return;
        const voice = require('./voice');
        if (!voiceBusy.has(guildId)) {
          voiceBusy.add(guildId);
          voice.startSpeech(guildId);
          voiceReplyStart.set(guildId, Date.now());
          const now = Date.now();
          const t0 = pcmTurnAt.get(guildId);
          const t1 = forceTurnAt.get(guildId);
          ctx.log(`[voice] firstAudio pcmMs=${t0 ? now - t0 : -1} speakingStopMs=${t1 ? now - t1 : -1}`);
        }
        try { voice.pushPcm24Play(guildId, pcm); } catch (e) { ctx.log(`[voice] converse play: ${e.message}`); }
      },
      onSpeechStart: () => {
        if (cfg.voice_barge_in === false) return;
        const v = require('./voice');
        // Echo: xAI server_vad hears her playback. Ignore while playing. Local Discord 3s barge owns interrupt.
        if (v.isSpeaking(guildId) || voiceBusy.has(guildId)) return;
      },
      onSpeechStop: () => {
        const v = require('./voice');
        if (v.isSpeaking(guildId) || voiceBusy.has(guildId)) return;
        clearVoiceOverlap(guildId);
      },
      onAssistantText: (text) => {
        const ch = voiceText.get(guildId);
        const t = String(text || '').trim();
        if (!t) return;
        logTranscript(guildId, NAME, t);
        if (ch && shouldPostLive({ offSet: transcriptOffChannels, cid: ch.id, instanceDefault: voicePostTranscript })) {
          ch.send(`🔊 **${NAME}:** ${t.slice(0, 1800)}`).catch(() => {});
        }
      },
      onFunctionCall: ({ name, callId, arguments: args }) => {
        runLiveFunction(guildId, session, name, callId, args);
      },
      onResponseDone: () => {
        const voice = require('./voice');
        // Keep mouth/busy until the pacer actually finishes. Deleting voiceBusy here
        // unmuted uplink and cleared barge while A–Z was still queued.
        Promise.resolve(voice.endPcmPlayback(guildId))
          .catch(() => {})
          .then(() => {
            voiceBusy.delete(guildId);
            const convDone = converseSessions.get(guildId);
            if (convDone) convDone._responseOpen = false;
            voice.endSpeech(guildId);
            const sp = converseSpeaker.get(guildId);
            if (sp && sp.userId) {
              const next = armFollowUp({ now: Date.now(), windowMs: VOICE_WINDOW_MS, userId: String(sp.userId) });
              if (next) voiceActive.set(guildId, next);
              pcmRing.delete(guildId + ':' + sp.userId);
            }
            voiceReplyStart.delete(guildId);
            clearVoiceOverlap(guildId);
            setVoiceStatus(null);
            flushDeferredCreate(guildId);
          });
      },
      onCancelled: () => {
        const convDone = converseSessions.get(guildId);
        if (convDone) convDone._responseOpen = false;
        ctx.log('[voice] response.cancelled → _responseOpen=false');
      },
      onUserTranscript: (text, ev, meta) => {
        const line = String(text || '').trim();
        if (!line) return;
        const sp = converseSpeaker.get(guildId) || {};
        const who = sp.name || 'speaker';
        const final = !!(meta && meta.final) || (ev && String(ev.type || '').endsWith('completed'));
        ctx.log('[voice] grok-transcript final=' + (final ? '1' : '0') + ' chars=' + line.length);
        upsertLiveUserLine(guildId, who, line, final);
        if (final && wasNotForHer(line)) {
          const c = converseSessions.get(guildId);
          const herMouth = mouthBusy(guildId);
          if (c) {
            c._skipNoted = true;
            c._skipNextCreate = true;
            c._bargeAwaitTranscript = false;
            c._pendingStop = null;
            c._pendingFirst = null;
            refreshRoomInstructions(guildId);
          }
          if (herMouth || (c && c._responseOpen)) {
            ctx.log('[voice] stop-while-playing → cancel now');
            stopVoiceReply(guildId, { chime: false, barge: true });
            // Transcript already identified stop/hold — do not wait for it again.
            if (c) { c._bargeAwaitTranscript = false; c._skipNextCreate = true; }
            return;
          }
          ctx.log('[voice] skip-noted (not for her); stay open');
          return;
        }
        const cPend = converseSessions.get(guildId);
        if (final && cPend && cPend._pendingStop) {
          const humans = countHumansNow(guildId);
          const named = addressesName(line);
          const speakerId = (cPend._pendingStop && cPend._pendingStop.userId) || (converseSpeaker.get(guildId) || {}).userId;
          if (cPend._skipNextCreate && !cPend._bargeAwaitTranscript) {
            cPend._skipNextCreate = false;
            cPend._pendingStop = null;
            ctx.log('[voice] speaking-stop skipped (stop/hold)');
            return;
          }
          const afterBarge = !!(cPend._pendingStop && cPend._pendingStop.afterBarge);
          const want = afterBarge
            || isGroupAddressee({ named, speakerId, lastAnsweredId: cPend._lastAnsweredId, lastSpeakerId: cPend._lastSpeakerId, humans });
          if (want) {
            cPend._pendingStop = null;
            cPend._skipNextCreate = false;
            cPend._bargeAwaitTranscript = false;
            cPend._lastAnsweredId = speakerId ? String(speakerId) : cPend._lastAnsweredId;
            cPend._awaitFirstUser = false;
            cPend._responseOpen = true;
            try { cPend.createResponse(); ctx.log('[voice] group addressee → response.create'); } catch (e) {
              cPend._responseOpen = false;
              ctx.log('[voice] createResponse: ' + e.message);
            }
          } else {
            cPend._pendingStop = null;
            ctx.log('[voice] speaking-stop not for her');
          }
        }
      },
      onError: (e) => ctx.log(`[voice] converse error: ${e}`),
      onSession: () => {
        session._sessionUpdated = true;
        armLiveGreet(guildId);
      },
      onClose: (info) => {
        const code = info && info.code;
        const reason = (info && info.reason) || '';
        ctx.log(`[voice] converse WS closed code=${code} reason=${reason || '(none)'}`);
        const cur = converseSessions.get(guildId);
        if (cur && cur._leave) return;
        let voice; try { voice = require('./voice'); } catch (_) { return; }
        if (!voice.isListening(guildId) || !voice.isConnected(guildId)) return;
        ctx.log('[voice] converse reopening (still in VC)');
        tryOpenConverse(guildId, { greet: false }).then((s) => {
          if (s && voice.isListening(guildId)) converseSessions.set(guildId, s);
        }).catch((e) => ctx.log(`[voice] converse reopen: ${e.message}`));
      },
    }, { getKey: async () => voiceKey, WebSocket: WS, instructions: VOICE_GUIDANCE + '\n\n' + liveRoomLine(guildId), tools: [] });
    try { await session.ready; } catch (e) {
      ctx.log(`[voice] converse unavailable (${e.message}) — Flux+CLI+TTS`);
      try { session.close(); } catch (_) {}
      return null;
    }
    session._wantGreet = !!greet;
    return session;
  }

  async function startVoiceListening(guildId) {
    const voice = require('./voice');
    const conv = await tryOpenConverse(guildId);
    const { rtModel, rtLive, rtProvider, vad, realtime } = await realtimeListenConfig();
    if (conv) {
      converseSessions.set(guildId, conv);
      ctx.log(`[voice] converse bound ${converseGrok.MODEL} voice=ara tools=[] — skip handleStream + ElevenLabs TTS`);
    }
    voice.startListening(guildId, client, {
      transcribe: sttTranscribe,
      realtime: conv ? false : realtime,
      converse: !!conv,
      vad: conv ? { ...vad, endpointMs: 500 } : vad,
      realtimeModel: rtModel,
      realtimeLive: rtLive,
      realtimeProvider: rtProvider,
      onUtterance: (name, text, meta) => handleVoiceUtterance(guildId, name, text, meta),
      onPartial: (name, text) => onVoicePartial(guildId, name, text),
      onPcm24: conv ? (userId, pcm, meta) => {
        if (!pcm || !pcm.length || !userId) return;
        const vmod = require('./voice');
        if (vmod.isSelfUser(client, userId)) return;
        const key = guildId + ':' + userId;
        let arr = pcmRing.get(key);
        if (!arr) { arr = []; pcmRing.set(key, arr); }
        arr.push(pcm);
        let total = 0; for (const b of arr) total += b.length;
        while (arr.length > 1 && total > PCM_RING_BYTES) { total -= arr[0].length; arr.shift(); }
        if (voiceMuted.has(guildId)) return;
        converseSpeaker.set(guildId, { userId: String(userId), name: (meta && meta.name) || String(userId) });
        // Phone call: every human in the VC goes to the WS. No last-speaker / wake gate.
        // Mute uplink only while her mouth is actually playing (echo). Not voiceBusy.
        // Reopen replaces the Map entry — PCM must go to the CURRENT session, not the join-time conv.
        const live = converseSessions.get(guildId);
        if (!live) return;
        // Keep uplink open while isSpeaking(guildId) so we hear Stop / hold on. Per-user Discord PCM, not her mix.
        if (!pcmTurnLogged.has(guildId)) {
          pcmTurnLogged.add(guildId);
          pcmTurnAt.set(guildId, Date.now());
          ctx.log(`[voice] PCM → WS bytes=${pcm.length}`);
        }
        live.pushPcm24(pcm);
      } : undefined,
      onBargeIn: () => {
        if (cfg.voice_barge_in === false) return;
        if (!voiceOverlapArm.has(guildId)) {
          ctx.log('[voice] overlap arm (mouth playing)');
        }
        armVoiceOverlap(guildId, { live: converseSessions.has(guildId) });
      },
      onBargeEnd: () => {
        const arm = voiceOverlapArm.get(guildId);
        if (arm) {
          const ms = Date.now() - arm;
          ctx.log('[voice] overlap ' + ms + 'ms → ignored (need ' + BARGE_MIN_SPEECH_MS + ' continuous)');
        }
        clearVoiceOverlap(guildId);
      },
      onSpeechEnd: (userId) => {
        const c = converseSessions.get(guildId);
        if (!c || typeof c.createResponse !== 'function') return;
        const humans = countHumansNow(guildId);
        const firstAfterGreet = !!c._awaitFirstUser;
        const herMouth = mouthBusy(guildId);
        const speakerId = userId || (converseSpeaker.get(guildId) || {}).userId;
        // C-named: commit always so a late/missing transcript still has audio.
        if (typeof c.commitAudio === 'function') { try { c.commitAudio(); } catch (_) {} }
        if (herMouth) {
          if (firstAfterGreet) {
            c._pendingFirst = { userId: speakerId, at: Date.now() };
            ctx.log('[voice] speaking-stop during greet → pending first');
            return;
          }
          ctx.log('[voice] speaking-stop during mouth (barge, no create)');
          return;
        }
        if (c._bargeAwaitTranscript) {
          pcmTurnLogged.delete(guildId);
          c._pendingStop = { userId: speakerId, at: Date.now(), afterBarge: true };
          ctx.log('[voice] speaking-stop after barge → wait transcript');
          return;
        }
        if (c._skipNextCreate) {
          c._skipNextCreate = false;
          pcmTurnLogged.delete(guildId);
          ctx.log('[voice] speaking-stop skipped (stop/hold)');
          return;
        }
        if (c._responseOpen) {
          ctx.log('[voice] speaking-stop skipped (response already open)');
          return;
        }
        pcmTurnLogged.delete(guildId);
        forceTurnAt.set(guildId, Date.now());
        const named = false;
        const want = firstAfterGreet
          || shouldForceTurn({ humans, herMouth: false })
          || isGroupAddressee({ named, speakerId, lastAnsweredId: c._lastAnsweredId, lastSpeakerId: c._lastSpeakerId, humans });
        c._lastSpeakerId = speakerId ? String(speakerId) : c._lastSpeakerId;
        if (!want) {
          c._pendingStop = { userId: speakerId, at: Date.now() };
          ctx.log('[voice] speaking-stop commit (group, other humans)');
          return;
        }
        c._awaitFirstUser = false;
        c._pendingFirst = null;
        c._lastAnsweredId = speakerId ? String(speakerId) : c._lastAnsweredId;
        c._responseOpen = true;
        try {
          c.createResponse();
          ctx.log(firstAfterGreet ? '[voice] first-utterance after greet → response.create'
            : (humans <= 1 ? '[voice] 1:1 speaking-stop → response.create' : '[voice] group speaking-stop → response.create'));
        } catch (e) {
          c._responseOpen = false;
          ctx.log('[voice] createResponse: ' + e.message);
        }
      },
      log: (m) => ctx.log(`[voice] ${m}`),
    });
    armLiveGreet(guildId);
  }

  async function getInvokerVoiceChannel(turn) {
    const guildId = voiceTools.guildIdFromTurn(turn);
    const userId = voiceTools.senderIdFromTurn(turn);
    if (!guildId || !userId) return null;
    try {
      const guild = await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(String(userId));
      return (member && member.voice && member.voice.channel) || null;
    } catch (_) { return null; }
  }

  async function currentSynthesize(text) {
    let id = 'openai-tts';
    try { id = voiceEngines.resolve('synthesize').engine_id || id; } catch (_) {}
    if (id === 'elevenlabs') {
      const { audio } = await sharedTts.synthesize(text, {
        provider: 'elevenlabs',
        voice: cfg.voice_id || undefined,
        model: cfg.tts_model || undefined,
        keyName: cfg.elevenlabs_key_name || 'elevenlabs_api_key',
      });
      return audio;
    }
    const { audio } = await sharedTts.synthesize(text);
    return audio;
  }

  try {
  voiceTools.bind({
    voice: require('./voice'),
    getInvokerVoiceChannel,
    startListening: startVoiceListening,
    synthesize: currentSynthesize,
    getChannelInfo: async (guildId) => {
      let voice; try { voice = require('./voice'); } catch (_) { return { channelId: '', channelName: '' }; }
      const channelId = (voice.channelIdOf && voice.channelIdOf(guildId)) || '';
      let channelName = '';
      if (channelId) {
        try {
          const ch = await client.channels.fetch(channelId);
          channelName = (ch && ch.name) || '';
        } catch (_) {}
      }
      return { channelId: String(channelId || ''), channelName };
    },
    engines: async () => {
      let transcribeEngine = '';
      let ttsEngine = '';
      const keys = await engineKeys();
      try { transcribeEngine = voiceEngines.resolve('realtime_transcribe', { keys }).engine_id || ''; } catch (_) {}
      try { ttsEngine = voiceEngines.resolve('synthesize', { keys }).engine_id || ''; } catch (_) {}
      let converseEngine = '';
      try { converseEngine = voiceEngines.resolve('converse', { keys }).engine_id || ''; } catch (_) {}
      return { transcribeEngine, ttsEngine, converseEngine };
    },
  });
  } catch (e) { ctx.log("voice-tools bind failed: " + e.message); }

  // Join the requester's voice channel + start listening. Triggered by the `join-voice`
  // command (@mention driven, in handleControlCommands).
  async function doJoinVoice(message) {
    if (!message.guild) return;
    ctx.log(`[voice] join-voice requested by ${message.author && message.author.username} in #${message.channel && message.channel.name} — caller vc=${(message.member && message.member.voice && message.member.voice.channel && message.member.voice.channel.name) || 'NONE'}`);
    let voice;
    try { voice = require('./voice'); } catch (e) { ctx.log(`voice module load failed: ${e.message}`); message.channel.send('⚠️ Voice module unavailable.').catch(() => {}); return; }
    const vc = message.member?.voice?.channel;
    if (!vc) { message.channel.send(`🎙️ Hop into a voice channel first, then \`@${client.user.username} join-voice\`.`).catch(() => {}); return; }
    try {
      await voice.joinChannel(vc);
      voiceText.set(message.guild.id, message.channel);
      // Resolve the realtime_transcribe ROLE (voice-engine layer, #113/#140) instead of hard-wiring a
      // model, so Settings picks the engine. `live` = a streaming model (partials during speech + we
      // finalize on commit); otherwise a server-VAD model (finalizes per turn on the server's VAD).
      await startVoiceListening(message.guild.id);
      if (converseSessions.has(message.guild.id)) {
        ctx.log('[voice] grok-only Live (no Flux)');
      } else {
        const { rtModel, rtLive, rtProvider, vad } = await realtimeListenConfig();
        ctx.log(`[voice] realtime role → ${rtProvider}:${rtModel} (live=${rtLive}) · endpoint=${vad.endpointMs}ms rmsGate=${vad.rmsGate}`);
      }
      const oid = String(message.author.id);
      const oname = (message.author && (message.author.globalName || message.author.username)) || oid;
      converseSpeaker.set(message.guild.id, { userId: oid, name: oname });
      const held = armFollowUp({ now: Date.now(), windowMs: VOICE_WINDOW_MS, userId: oid });
      if (held) voiceActive.set(message.guild.id, held);
      ctx.log(`[voice] JOINED ${vc.name} — open-line (converse=${converseSessions.has(message.guild.id)}, grok-only=${converseSessions.has(message.guild.id)}, post_transcript=${!isTranscriptOff(transcriptOffChannels, message.channel.id) && voicePostTranscript})`);
      setVoiceStatus(`🎧 listening · ${vc.name}`);
      const originOff = isTranscriptOff(transcriptOffChannels, message.channel.id);
      const transcriptNote = originOff
        ? `Live transcript is **off** in this channel — I listen quietly. \`@${client.user.username} scribe-on\` to restore.`
        : (voicePostTranscript
          ? 'I post everyone\'s words as `🗣️ name: …` (turn that off with `scribe-off`).'
          : 'Live transcript is **off** — I listen quietly' + (voiceTranscriptFile ? ' and post a full transcript `.txt` when I leave.' : '.'));
      message.channel.send(`🎙️ Joined **${vc.name}** — I'm on the call. ${transcriptNote} Just talk. I'll jump in when it looks like you want me. \`@${client.user.username} leave-voice\` to hang up.`).catch(() => {});
    } catch (e) { ctx.log(`voice join failed: ${e.stack || e.message}`); message.channel.send(`⚠️ Couldn't join voice: ${e.message}`).catch(() => {}); }
  }

  async function doLeaveVoice(message) {
    if (!message.guild) return;
    let voice; try { voice = require('./voice'); } catch (_) { return; }
    const originCh = voiceText.get(message.guild.id) || message.channel;
    voiceText.delete(message.guild.id);
    voiceMuted.delete(message.guild.id);
    closeConverse(message.guild.id);
    const left = voice.leave(message.guild.id);
    setVoiceStatus(null); // back to idle/config presence
    message.channel.send(left ? '👋 Left the voice channel.' : "I'm not in a voice channel.").catch(() => {});
    if (left) await uploadTranscript(message.guild.id, originCh); // full-session .txt to the origin channel
  }

  client.on('voiceStateUpdate', (oldState, newState) => {
    try {
      const guildId = String((newState.guild && newState.guild.id) || (oldState.guild && oldState.guild.id) || '');
      if (!guildId || !converseSessions.has(guildId)) return;
      const voice = require('./voice');
      let voiceChannelId = '';
      try { voiceChannelId = String(voice.channelIdOf(guildId) || ''); } catch (_) {}
      if (!voiceChannelId) return;
      const oldCid = oldState.channelId && String(oldState.channelId);
      const newCid = newState.channelId && String(newState.channelId);
      if (oldCid !== voiceChannelId && newCid !== voiceChannelId) return;
      refreshRoomInstructions(guildId);
      // Room line only when membership changes. No spoken hello on join.
    } catch (_) {}
  });

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
    const { exec, spawn, execSync, execFile, execFileSync } = require('child_process');
    const repo = path.join(__dirname, '..', '..', '..'); // connectors/types/discord → repo root
    await message.channel.send('🔄 Updating asmltr — pulling latest + reinstalling. I\'ll confirm here once the restart completes (~15s).').catch(() => {});
    let branch;
    try { branch = execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 15000 }).trim(); }
    catch (e0) { message.channel.send(`⚠️ Update failed (branch): ${String(e0.message).slice(0, 400)}`).catch(() => {}); return; }
    let resetArgv, fetchArgv;
    try { resetArgv = updateResetArgv(branch); fetchArgv = fetchOriginArgv(branch); }
    catch (e0) { message.channel.send(`⚠️ Update failed (ref): ${String(e0.message).slice(0, 400)}`).catch(() => {}); return; }
    execFile('git', ['-C', repo, ...fetchArgv], { timeout: 120000 }, (e1, o1, s1) => {
      if (e1) { message.channel.send(`⚠️ Update failed (git): ${String(s1 || e1.message).slice(0, 400)}`).catch(() => {}); return; }
      execFile('git', ['-C', repo, ...resetArgv], { timeout: 120000 }, (e1b, o1b, s1b) => {
      const e1 = e1b, o1 = o1b, s1 = s1b;
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
  app.post('/send-message', requireConnectorToken, async (req, res) => {
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
  // File posts (`kind: file` + path) are how `asmltr post` attaches without Bash:
  // stage a safe name, POST here, delete the staged copy only after messageId.
  app.post('/out', requireConnectorToken, async (req, res) => {
    let outMarked = null;
    try {
      const { kind = 'text', target: tg, text, path: filePath, caption, source_guild, on_behalf_of, reply_to, title, source_channel, query } = req.body || {};
      if (kind === 'guild_resolve') {
        // Mute/disable is inbound only. Name lookup includes muted channels/threads.
        const gp = require('../../../shared/discord-targets');
        const q = String(query || tg || '').trim();
        if (!source_guild) return res.status(400).json({ ok: false, error: 'source guild required' });
        if (!q) return res.status(400).json({ ok: false, error: 'query required' });
        const rows = await listGuildPostTargets(client, source_guild, gp);
        return res.json({ ok: true, posted: false, matches: gp.rankTargets(q, rows) });
      }
      const channel = await client.channels.fetch(resolveChannel(tg), { force: true });
      if (!channel) return res.status(404).json({ ok: false, error: 'channel not found' });
      const procCid = source_channel || channel.id;
      if (procCid && !processing.has(String(procCid))) {
        abortTarget(procCid, on_behalf_of || '', 'send');
        outMarked = { cid: procCid, kind: 'send' };
      }
      if (kind === 'guild_post') {
        // Mute/disable is inbound only. Cross-post into a muted channel/thread is allowed.
        const gp = require('../../../shared/discord-targets');
        if (gp.sameChannel(source_channel, channel.id) || gp.sameChannel(source_channel, resolveChannel(tg))) {
          return res.json({ ok: true, skipped: true, reason: 'same_channel' });
        }
        const same = gp.sameGuild(source_guild, gp.destGuildId(channel));
        if (!same.ok) return res.status(403).json({ ok: false, error: same.error });
        const pref = gp.prefaceOnBehalf(on_behalf_of, text);
        if (!pref.ok) return res.status(400).json({ ok: false, error: pref.error });
        if (gp.isForumChannel(channel)) {
          const thread = await channel.threads.create({
            name: gp.forumTitle(title, pref.body || String(text || '')),
            message: { content: pref.text },
          });
          return res.json({ ok: true, messageId: thread.id, threadId: thread.id,
            conversation_key: `discord:${ctx.instanceId}:channel:${thread.id}` });
        }
        if (!channel.isTextBased()) return res.status(404).json({ ok: false, error: 'channel not found / not text' });
        const opts = { content: pref.text };
        if (reply_to) opts.reply = { messageReference: String(reply_to) };
        const posted = await channel.send(opts);
        const conversation_key = channel.type === 1
          ? `discord:${ctx.instanceId}:dm:${(channel.recipient && channel.recipient.id) || tg}`
          : `discord:${ctx.instanceId}:channel:${channel.id}`;
        return res.json({ ok: true, messageId: posted.id, conversation_key });
      }
      if (!channel.isTextBased()) return res.status(404).json({ ok: false, error: 'channel not found / not text' });
      // any file kind (photo/file/attachment/document/image) → send as a Discord attachment
      const isFile = ['photo', 'file', 'attachment', 'document', 'image'].includes(kind);
      if (isFile && !filePath) return res.status(400).json({ ok: false, error: 'file kind requires a `path`' });
      if (isFile) {
        const stage = require('../../../shared/attach-stage');
        if (!stage.outboundFileAllowed(filePath)) {
          return res.status(403).json({ ok: false, error: 'path not allowed (attach-stage, gen-ref, uploads, or silo)' });
        }
      }
      const m = isFile ? await channel.send({ content: caption || text || '', files: [filePath] }) : await channel.send(text);
      // Report the conversation_key this target maps to (matches an inbound from the same place), so a
      // core-mediated send can ASSIMILATE this message into that session's context (it was posted from
      // ANOTHER session; without this the destination session never learns it "said" it).
      const conversation_key = channel.type === 1
        ? `discord:${ctx.instanceId}:dm:${(channel.recipient && channel.recipient.id) || tg}`
        : `discord:${ctx.instanceId}:channel:${channel.id}`;
      res.json({ ok: true, messageId: m.id, conversation_key });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    finally {
      if (outMarked) releaseAbortTarget(outMarked.cid, outMarked.kind);
    }
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
  app.post('/voice', requireConnectorToken, async (req, res) => {
    try {
      const tool = req.body && req.body.tool;
      const args = (req.body && req.body.args) || {};
      const turn = Object.assign({ channel: 'discord' }, (req.body && req.body.turn) || {});
      if (!voiceTools.BY_NAME[tool]) return res.status(400).json({ ok: false, error: 'unknown tool: ' + tool });
      const mutating = /^(voice_join|voice_leave|voice_listen|voice_speak)$/.test(tool);
      if (mutating) {
        const fake = {
          author: { id: voiceTools.senderIdFromTurn(turn), username: '' },
          guild: { id: voiceTools.guildIdFromTurn(turn) },
        };
        if (!(await isOwner(fake))) {
          return res.status(403).json({ ok: false, error: 'Only my owner can run that command.' });
        }
      }
      const r = await voiceTools.invokeLocal(tool, args, turn);
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  const httpServer = app.listen(cfg.http_port || 3016, '127.0.0.1', () => ctx.log(`send-message API on 127.0.0.1:${cfg.http_port || 3016}`));

  await client.login(token);

  return {
    async stop() { clearInterval(hbTimer); try { await client.destroy(); } catch (_) {} try { httpServer.close(); } catch (_) {} persistMemory(); },
    health() { return { online: !!client.user, silenced }; },
  };
}

/** Name lookup for asmltr send (discord-targets): text + announcement + forum + media, plus their threads. */
async function listGuildPostTargets(client, sourceGuild, gp) {
  const guild = await client.guilds.fetch(String(sourceGuild));
  await guild.channels.fetch();
  const rows = [];
  const seen = new Set();
  const add = (row) => {
    const id = String((row && row.id) || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    rows.push(row);
  };
  async function pullThreads(ch) {
    if (!ch || !ch.threads) return;
    try {
      if (ch.threads.fetchActive) {
        const active = await ch.threads.fetchActive();
        for (const th of (active.threads || active).values()) {
          add({ id: String(th.id), name: th.name, kind: 'thread', parent: ch.name, parentId: String(ch.id) });
        }
      }
    } catch (_) {}
    try {
      if (ch.threads.fetchArchived) {
        const arch = await ch.threads.fetchArchived({ limit: 100 });
        for (const th of (arch.threads || arch).values()) {
          add({ id: String(th.id), name: th.name, kind: 'thread', parent: ch.name, parentId: String(ch.id) });
        }
      }
    } catch (_) {}
  }
  for (const ch of guild.channels.cache.values()) {
    if (gp.isThreadChannel(ch)) {
      add({
        id: String(ch.id), name: ch.name, kind: 'thread',
        parent: (ch.parent && ch.parent.name) || undefined,
        parentId: ch.parentId ? String(ch.parentId) : undefined,
      });
      continue;
    }
    if (gp.isForumChannel(ch)) add({ id: String(ch.id), name: ch.name, kind: 'forum' });
    else if (gp.isPostableGuildChannel(ch)) add({ id: String(ch.id), name: ch.name, kind: 'channel' });
    if (gp.shouldFetchThreads(ch)) await pullThreads(ch);
  }
  return rows;
}

module.exports = { meta, start, listGuildPostTargets };
