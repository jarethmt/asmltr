#!/usr/bin/env node
'use strict';
/**
 * asmltr — terminal client + TUI (plan §B9).
 *
 * Read-only commands (Phase 1) consume the live collector API. Runs host-local;
 * uses the control token from env when present. The `attach` cross-channel
 * takeover (claim → resume in tmux) lands with the control plane in Phase 4.
 *
 *   asmltr            live TUI dashboard (sessions + event log + cpu)
 *   asmltr ls         list active sessions
 *   asmltr brief      compact summary (the morning-brief JSON, rendered)
 *   asmltr events     recent events (--surface S --identity I --limit N)
 *   asmltr tail       live global event stream
 *   asmltr watch KEY  live event stream for one session
 *   asmltr system     current system metrics
 *   asmltr help
 */

const { spawnSync, execFileSync } = require('child_process');
const os = require('os');

const BASE = process.env.ASMLTR_COLLECTOR_BASE || 'http://127.0.0.1:3017';
const CORE_BASE = process.env.ASMLTR_CORE_BASE || 'http://127.0.0.1:3023';
const MANAGER_BASE = process.env.ASMLTR_MANAGER_BASE || 'http://127.0.0.1:3024';
const MANAGER_TOKEN = process.env.ASMLTR_MANAGER_TOKEN || '';
const TOKEN = process.env.ASMLTR_INSIGHTS_TOKEN || '';
const CONTROL_TOKEN = process.env.ASMLTR_INSIGHTS_CONTROL_TOKEN || '';
const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
const controlHeaders = CONTROL_TOKEN ? { Authorization: `Bearer ${CONTROL_TOKEN}` } : {};
const ACTOR = `cli:${os.userInfo().username}@${(process.env.SSH_TTY || process.env.STY || 'local').split('/').pop()}`;

// --- tiny ansi helpers -------------------------------------------------------
const A = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  grn: (s) => `\x1b[32m${s}\x1b[0m`,
  yel: (s) => `\x1b[33m${s}\x1b[0m`,
  cyn: (s) => `\x1b[36m${s}\x1b[0m`,
  mag: (s) => `\x1b[35m${s}\x1b[0m`,
};
const SURFACE_COLOR = {
  discord: A.mag, telegram: A.cyn, github: A.grn, mcp: A.yel,
  'assistant-web': A.cyn, 'assistant-native': A.cyn, 'eve-assistant-web': A.cyn, 'eve-assistant-native': A.cyn, 'claude-code': A.bold, core: A.bold, system: A.dim,
};
const paint = (surface, s) => (SURFACE_COLOR[surface] || ((x) => x))(s);

async function api(path) {
  const res = await fetch(BASE + path, { headers: authHeaders });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return res.json();
}
async function coreApi(path, method = 'GET', body) {
  const res = await fetch(CORE_BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `${res.status} — ${path}`);
  return j;
}
async function controlApi(path, method = 'POST', body) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...controlHeaders }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `${res.status} — ${path}`);
  return j;
}
const tmuxName = (key) => 'asmltr-' + key.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 60);
function tmuxHasSession(name) {
  try { execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }); return true; } catch { return false; }
}

function ageOf(unixMs) {
  if (!unixMs) return '?';
  const s = Math.max(0, Math.floor((Date.now() - unixMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function parsePayload(p) { try { return typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch { return {}; } }
function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

// --- flag parsing (--key val) ------------------------------------------------
function flags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { f[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return f;
}

// --- commands ----------------------------------------------------------------
async function cmdLs() {
  const { sessions } = await api('/api/sessions?active=1');
  if (!sessions.length) return console.log(A.dim('no active sessions'));
  console.log(A.bold(pad('SURFACE', 10) + pad('KIND', 11) + pad('AGE', 6) + pad('IDLE', 6) + pad('TOK', 8) + pad('MUX', 7) + 'TASK / KEY'));
  for (const s of sessions) {
    const line = pad(s.surface, 10) + pad(s.kind, 11) + pad(ageOf(s.started_unix), 6) +
      pad(ageOf(s.last_activity_unix), 6) + pad(s.tokens_total || 0, 8) + pad(s.multiplexer || 'none', 7) +
      (s.task ? String(s.task).slice(0, 50) : s.session_id);
    console.log(paint(s.surface, line));
  }
  console.log(A.dim(`\n${sessions.length} active`));
}

async function cmdBrief() {
  const b = await api('/api/brief');
  console.log(A.bold('asmltr brief'));
  console.log(`  active sessions : ${A.grn(b.active_sessions)}`);
  console.log(`  tokens (24h)    : ${b.tokens_24h}`);
  const bys = b.tokens_by_surface_24h || {};
  for (const [surf, tok] of Object.entries(bys)) console.log(`    ${pad(surf, 22)} ${tok}`);
  if (b.sessions && b.sessions.length) {
    console.log(A.bold('\n  active:'));
    for (const s of b.sessions) console.log(`    ${paint(s.surface, pad(s.surface, 10))} ${A.dim(s.kind)} ${s.task ? String(s.task).slice(0, 60) : s.id}`);
  }
}

async function cmdEvents(f) {
  const qs = new URLSearchParams();
  if (f.surface) qs.set('surface', f.surface);
  if (f.identity) qs.set('identity', f.identity);
  if (f.session) qs.set('session', f.session);
  qs.set('limit', f.limit || '40');
  const { events } = await api('/api/events?' + qs.toString());
  for (const e of events.reverse()) printEvent(e);
  console.log(A.dim(`\n${events.length} events`));
}

async function cmdContext(rest) {
  // asmltr context <session-id> [-n <events>] [--full]
  // A condensed, readable transcript + live status of one session, BY ID — the drill-down primitive:
  // copy an id off the dashboard and hand this output to another session to "pull context from X".
  let limit = 60, full = false; const words = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '-n' || t === '--limit') limit = Number(rest[++i]) || 60;
    else if (t === '--full') full = true;
    else words.push(t);
  }
  const id = words[0];
  if (!id) throw new Error('usage: asmltr context <session-id> [-n <events>] [--full]\n' +
    '  Condensed transcript + status of a session, by id (copy the id from the dashboard).\n' +
    '  --full also includes tool inputs/outputs and thinking. Ideal to hand to another session.');
  const { sessions } = await api('/api/sessions');
  const s = (sessions || []).find((x) => x.session_id === id) || (sessions || []).find((x) => String(x.session_id).includes(id));
  const sid = (s && s.session_id) || id;
  const { events } = await api('/api/events?' + new URLSearchParams({ session: sid, limit: String(limit) }).toString());

  console.log(A.bold('═ session ') + sid);
  if (s) {
    console.log('  ' + [paint(s.surface, s.surface), s.identity, s.working_dir, s.status && A.dim(s.status)].filter(Boolean).join(' · '));
    if (s.title) console.log('  ' + A.dim('title:') + ' ' + s.title);
    if (s.activity) console.log('  ' + A.dim('doing:') + ' ' + s.activity);
    if (s.last_activity_unix) { const ms = s.last_activity_unix > 1e12 ? s.last_activity_unix : s.last_activity_unix * 1000; console.log('  ' + A.dim('last active: ' + ageOf(ms) + ' ago')); }
  } else {
    console.log(A.dim('  (session not in the live table — showing its recorded events)'));
  }
  const rows = (events || []).slice().reverse().filter((e) => ['inbound', 'outbound', 'tool', 'tool_result', 'thinking'].includes(e.event_type));
  console.log(A.dim(`─ transcript · ${rows.length} events, oldest→newest ─`));
  const cap = full ? 100000 : 500;
  for (const e of rows) {
    const p = parsePayload(e.payload) || {};
    if (e.event_type === 'inbound') console.log(A.bold('User: ') + String(p.text || '').replace(/\s+/g, ' ').slice(0, cap));
    else if (e.event_type === 'outbound') console.log(A.grn('Asst: ') + String(p.text || '').replace(/\s+/g, ' ').slice(0, cap));
    else if (e.event_type === 'tool') console.log(A.dim('  · ' + (p.tool || 'tool') + (p.input ? ' ' + String(typeof p.input === 'object' ? JSON.stringify(p.input) : p.input).replace(/\s+/g, ' ').slice(0, full ? 2000 : 100) : '')));
    else if (full && e.event_type === 'tool_result') console.log(A.dim('    ↳ ' + String(typeof p.output === 'object' ? JSON.stringify(p.output) : (p.output || '')).replace(/\s+/g, ' ').slice(0, 2000)));
    else if (full && e.event_type === 'thinking') console.log(A.dim('  💭 ' + String(p.text || '').replace(/\s+/g, ' ').slice(0, 800)));
  }
  if (!full) console.log(A.dim('\n(--full adds tool i/o + thinking)'));
}

function printEvent(e) {
  const t = new Date(e.ts).toISOString().slice(11, 19);
  const pl = parsePayload(e.payload);
  const detail = pl.text || pl.decision || pl.tool || (pl.chars != null ? `${pl.chars} chars` : '') || '';
  const tok = (e.tokens_in || e.tokens_out) ? A.dim(` ${e.tokens_in}/${e.tokens_out}`) : '';
  console.log(`${A.dim(t)} ${paint(e.surface, pad(e.surface, 9))} ${pad(e.event_type, 19)} ${A.dim(pad(e.identity || '-', 12))} ${String(detail).slice(0, 60)}${tok}`);
}

async function cmdSystem() {
  const { samples } = await api('/api/system?since=' + (Date.now() - 600000));
  if (!samples.length) return console.log(A.dim('no samples yet'));
  const s = samples[0];
  console.log(A.bold('system') + A.dim(`  (${ageOf(s.ts)} ago)`));
  console.log(`  cpu   : ${s.cpu_pct}%   load ${s.load1}/${s.load5}`);
  console.log(`  mem   : ${s.mem_used_mb}/${s.mem_total_mb} MB`);
  if (s.swap_total_mb) console.log(`  swap  : ${s.swap_used_mb}/${s.swap_total_mb} MB`);
  console.log(`  disk  : ${s.disk_used_pct}% used, ${s.disk_free_gb} GB free`);
}

async function liveStream(filterKey) {
  let io;
  try { io = require('socket.io-client'); }
  catch { console.error('socket.io-client not installed — run: cd ' + __dirname + ' && npm install'); process.exit(1); }
  console.log(A.dim(`connecting to ${BASE} …${filterKey ? ' (session ' + filterKey + ')' : ''}  [Ctrl-C to quit]`));
  const socket = io(BASE, { transports: ['websocket', 'polling'], auth: TOKEN ? { token: TOKEN } : {} });
  socket.on('connect', () => console.log(A.grn('connected')));
  socket.on('event', (e) => { if (!filterKey || e.session_id === filterKey) printEvent(e); });
  socket.on('disconnect', () => console.log(A.red('disconnected')));
}

// --- control / takeover ------------------------------------------------------
async function cmdAttach(key, f) {
  if (!key) throw new Error('usage: asmltr attach <conversation_key>');
  const claim = await coreApi('/v2/claim', 'POST', { conversation_key: key, by: ACTOR });
  console.log(A.grn('claimed') + A.dim(` — channel paused; engine=${claim.engine_session_id.slice(0, 8)} cwd=${claim.working_dir}`));
  const name = tmuxName(key);
  if (!tmuxHasSession(name)) {
    // Strip nested-Claude env so `claude` can spawn inside tmux. IS_SANDBOX=1 (not 'true') + the
    // configured permission mode → the resumed takeover runs at the same autonomy as `asmltr claude`.
    let permMode = 'bypassPermissions';
    try { permMode = require('../shared/runtime').getCliPermissionMode(); } catch (_) {}
    const env = { ...process.env };
    if (permMode === 'bypassPermissions') env.IS_SANDBOX = '1';
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const permFlag = permMode !== 'default' ? `--permission-mode ${permMode} ` : '';
    const r = spawnSync('tmux', ['new-session', '-d', '-s', name, '-c', claim.working_dir, `claude ${permFlag}--resume ${claim.engine_session_id}`], { env });
    if (r.status !== 0) { await coreApi('/v2/release', 'POST', { conversation_key: key }); throw new Error('tmux new-session failed: ' + (r.stderr || '')); }
    console.log(A.dim(`tmux session '${name}' created (claude --resume)`));
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    spawnSync('tmux', ['attach', '-t', name], { stdio: 'inherit' });
    // Returned: either detached (session still alive) or claude exited (gone).
    if (tmuxHasSession(name)) {
      console.log(A.yel(`detached — session '${name}' still running. re-attach: asmltr attach ${key}  ·  end: asmltr release ${key}`));
      if (!f.keep) console.log(A.dim('(channel stays paused until you `asmltr release` or the session ends)'));
    } else {
      await coreApi('/v2/release', 'POST', { conversation_key: key });
      console.log(A.grn('session ended — channel released'));
    }
  } else {
    console.log(A.yel(`no TTY — session created. Attach with: `) + A.bold(`tmux attach -t ${name}`));
    console.log(A.dim(`when done: asmltr release ${key}`));
  }
}

async function cmdRelease(key) {
  if (!key) throw new Error('usage: asmltr release <conversation_key>');
  const name = tmuxName(key);
  if (tmuxHasSession(name)) { try { execFileSync('tmux', ['kill-session', '-t', name]); console.log(A.dim(`killed tmux '${name}'`)); } catch {} }
  await coreApi('/v2/release', 'POST', { conversation_key: key });
  console.log(A.grn('released — channel resumes'));
}

async function cmdSend(rest) {
  // asmltr send <channel> <target> "<text>"  OR  ... --file <path> [--caption "..."] [--subject "..."]
  let file = null, caption = null, subject = null;
  const words = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--file') file = rest[++i];
    else if (t === '--caption') caption = rest[++i];
    else if (t === '--subject') subject = rest[++i]; // email subject (ignored by channels without one)
    else words.push(t);
  }
  const channel = words[0], target = words[1], text = words.slice(2).join(' ');
  if (!channel || !target || (!text && !file)) {
    throw new Error('usage: asmltr send <channel> <target> "<text>"\n' +
      '       asmltr send <channel> <target> --file <path> [--caption "<text>"] [--subject "<subj>"]\n' +
      '  e.g.  asmltr send discord 123 "shipping now"   ·   asmltr send email a@b.com "the body" --subject "Hello" --file /root/report.pdf');
  }
  const body = file
    ? { channel, target, kind: 'file', path: file, caption: caption != null ? caption : (text || undefined), subject }
    : { channel, target, kind: 'text', text, subject };
  // Route through the CORE (/v2/send) so a cross-channel post is ASSIMILATED into the destination
  // session's context (it learns it "said" this, instead of it looking foreign on the next read).
  // Fall back to the manager's /send if the core is unreachable — delivery still works, just no assimilation.
  let r = await fetch(CORE_BASE + '/v2/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((x) => x.json()).catch(() => null);
  if (!r || (r.error && /unreachable|ECONNREFUSED|fetch failed/i.test(r.error))) {
    const headers = { 'Content-Type': 'application/json' };
    if (MANAGER_TOKEN) headers.Authorization = 'Bearer ' + MANAGER_TOKEN;
    r = await fetch(MANAGER_BASE + '/send', { method: 'POST', headers, body: JSON.stringify(body) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
  }
  console.log(r.ok ? A.grn(`✓ sent ${file ? 'file ' + file : 'text'} to ${channel}:${target}${r.via ? ' (' + r.via + ')' : ''}${r.assimilated ? ' · assimilated' : ''}`) : A.red('send failed: ' + (r.error || JSON.stringify(r))));
}
async function cmdMap() {
  // where sessions are ACTIVELY working, from recent tool activity → grouped by git repo
  const r = await api('/api/map');
  const list = r.sessions || [];
  if (!list.length) return console.log(A.dim('no session has file activity in the last 30 min.\n' +
    '(map covers sessions asmltr observes — channel turns + `asmltr claude` sessions; it reads real\n' +
    ' tool activity, not the spawn dir, so a session shows up once it touches files.)'));
  const groups = {};
  for (const s of list) { (groups[s.repo] = groups[s.repo] || []).push(s); }
  for (const [repo, ss] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${A.bold(repo)}  ${ss.length > 1 ? A.red(`⚠ ${ss.length} sessions — possible collision`) : A.dim('1 session')}`);
    for (const s of ss) {
      const sub = s.dirs.map((d) => d.dir.replace(repo, '.') + (d.hits > 1 ? `(${d.hits})` : '')).join(' ');
      console.log(`   ${paint(s.surface, pad(s.surface, 11))} ${String(s.title || s.session_id).slice(0, 40)}  ${A.dim('· ' + ageOf(s.last_activity_unix) + ' ago · ' + sub)}`);
    }
  }
}
async function cmdWho(rest) {
  const p = rest[0];
  if (!p) throw new Error('usage: asmltr who <path>   (which sessions recently touched a file/dir)');
  const r = await api('/api/who?path=' + encodeURIComponent(p));
  if (r.error) return console.log(A.red(r.error));
  if (!r.sessions || !r.sessions.length) return console.log(A.dim(`no session has touched "${p}" in the last 6h`));
  console.log(A.bold(`sessions that recently touched "${p}":`));
  for (const s of r.sessions) {
    console.log(`  ${paint(s.surface, pad(s.surface, 11))} ${A.dim(ageOf(s.last_ts) + ' ago')}  ${s.hits} hits  ${A.dim(String(s.session_id).slice(0, 52))}`);
    if (s.sample) console.log(`     ${A.dim(s.sample)}`);
  }
}
async function cmdAnnounce(rest) {
  // asmltr announce "<text>" [--to <target>] [--urgent] [--ttl <seconds>]
  // Parse flags out of the args so the remaining words are the announcement text.
  const opts = { target: '*', priority: 'normal', from: ACTOR, ttl: null };
  const words = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--urgent') opts.priority = 'urgent';
    else if (t === '--to') opts.target = rest[++i];
    else if (t === '--from') opts.from = rest[++i];
    else if (t === '--ttl') opts.ttl = Number(rest[++i]);
    else words.push(t);
  }
  const text = words.join(' ');
  if (!text) throw new Error('usage: asmltr announce "<text>" [--to <target>] [--urgent] [--ttl <seconds>]\n' +
    '  target: * (all) · a session id · surface:discord · identity:<name>');
  const body = { text, target: opts.target, priority: opts.priority, from: opts.from, ttl: opts.ttl };
  const r = await fetch(CORE_BASE + '/v2/announce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((x) => x.json()).catch((e) => ({ error: e.message }));
  console.log(r.id ? A.grn(`📢 announced #${r.id} → ${r.target}  (${new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19)} UTC)`) : A.red('announce failed: ' + (r.error || '')));
}
function _parseSince(s) {
  const m = /^(\d+)\s*([smhd])$/.exec(String(s || '').trim());
  if (!m) return 0;
  return Number(m[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]]);
}
async function cmdUploads(rest) {
  // asmltr uploads [search words] [--channel x] [--sender s] [--since 2h|1d] [--limit N]
  // asmltr uploads get <id>   → print just the stored path (for piping into Read/tools)
  const uploads = require('../shared/uploads');
  if (rest[0] === 'get') {
    const rec = uploads.get(rest[1]);
    if (!rec) throw new Error(`no upload with id "${rest[1]}"`);
    return console.log(rec.path);
  }
  const o = { limit: 25 }; const words = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--channel') o.channel = rest[++i];
    else if (t === '--sender') o.sender = rest[++i];
    else if (t === '--limit') o.limit = Number(rest[++i]) || 25;
    else if (t === '--since') o.sinceMs = Date.now() - _parseSince(rest[++i]);
    else words.push(t);
  }
  if (words.length) o.query = words.join(' ');
  const items = uploads.list(o);
  if (!items.length) return console.log(A.dim('no uploads found' + (o.query ? ` for "${o.query}"` : '')));
  console.log(A.bold(`uploads · newest first · ${items.length}${o.channel ? ' · ' + o.channel : ''}${o.query ? ` · "${o.query}"` : ''}:`));
  for (const r of items) {
    const when = new Date(r.ts).toISOString().replace('T', ' ').slice(0, 16);
    const cap = r.caption ? `  ${A.dim('“' + r.caption.slice(0, 50) + '”')}` : '';
    console.log(`  ${paint(r.channel, pad(r.channel, 9))} ${A.dim(when)}  ${r.filename}  ${A.dim(`(${r.mime}, ${uploads.humanSize(r.size)})`)}${cap}`);
    console.log(`     ${A.dim(`id ${r.id} · from ${r.sender || '?'} · ${r.path}`)}`);
  }
}
async function cmdSteer(rest) {
  // asmltr steer <conversation_key> "<guidance>" [--from <label>] [--interrupt]
  // COERCIVE: pushes guidance into another session's LIVE turn. Off unless ASMLTR_MESH_STEER=on.
  let from = 'cli', interrupt = false; const words = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--from') from = rest[++i];
    else if (t === '--interrupt' || t === '--now') interrupt = true;
    else words.push(t);
  }
  const key = words[0], text = words.slice(1).join(' ');
  if (!key || !text) {
    throw new Error('usage: asmltr steer <session-key> "<guidance>" [--from <label>] [--interrupt]\n' +
      '  STEER pushes guidance into another session\'s LIVE turn — it acts on it now (coercive).\n' +
      '  --interrupt abandons its current turn; without it, guidance applies after the current turn.\n' +
      '  For a NON-coercive note the peer sees next turn and decides on itself, use `asmltr announce`.\n' +
      '  (Requires the operator to have enabled mesh steer: ASMLTR_MESH_STEER=on.)');
  }
  const r = await fetch(CORE_BASE + '/v2/inject', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_key: key, text, by: 'mesh:' + from, interrupt }),
  }).then((x) => x.json()).catch((e) => ({ error: e.message }));
  if (r.error) return console.log(A.red('steer failed: ' + r.error));
  console.log(A.grn(`↪ steered ${key}${interrupt ? ' (interrupted its turn)' : ''}`));
  if (r.reply) console.log(A.dim('  its reply: ') + String(r.reply).replace(/\s+/g, ' ').slice(0, 200));
}
async function cmdMail(rest) {
  // asmltr mail [list] [-n N] [--unseen] | read <uid> [--seen] | search "<query>" [-n N]
  const sub = rest[0] === 'read' || rest[0] === 'search' || rest[0] === 'list' ? rest[0] : 'list';
  const args = ['read', 'search', 'list'].includes(rest[0]) ? rest.slice(1) : rest;
  let n = 20, unseen = false, markSeen = false; const words = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '-n' || t === '--limit') n = Number(args[++i]) || 20;
    else if (t === '--unseen') unseen = true;
    else if (t === '--seen') markSeen = true;
    else words.push(t);
  }
  const post = (body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (MANAGER_TOKEN) headers.Authorization = 'Bearer ' + MANAGER_TOKEN;
    return fetch(MANAGER_BASE + '/read', { method: 'POST', headers, body: JSON.stringify({ channel: 'email', ...body }) })
      .then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
  };

  if (sub === 'read') {
    if (!words[0]) throw new Error('usage: asmltr mail read <uid> [--seen]');
    const r = await post({ op: 'read', uid: Number(words[0]), markSeen });
    if (!r.ok) return console.log(A.red(r.error || 'read failed'));
    const m = r.message;
    console.log(A.bold(`#${m.uid}  ${m.subject}`));
    console.log(A.dim(`from ${m.from}${m.date ? '  ·  ' + new Date(m.date).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : ''}`));
    console.log('\n' + (m.text || A.dim('(no text body)')) + '\n');
    if (m.attachments && m.attachments.length) console.log(A.dim('📎 attachments (saved to uploads):\n   ' + m.attachments.map((a) => `${a.name} → ${a.path}`).join('\n   ')));
    return;
  }

  const isSearch = sub === 'search';
  const query = words.join(' ');
  if (isSearch && !query) throw new Error('usage: asmltr mail search "<query>"');
  const r = await post(isSearch ? { op: 'search', query, limit: n } : { op: 'list', limit: n, unseen });
  if (!r.ok) return console.log(A.red(r.error || 'read failed'));
  const msgs = r.messages || [];
  if (!msgs.length) return console.log(A.dim(isSearch ? `no mail matches "${query}"` : (unseen ? 'no unseen mail' : 'inbox empty')));
  console.log(A.bold(`${isSearch ? 'search: "' + query + '"' : 'inbox'} · ${msgs.length}${unseen ? ' unseen' : ''} (newest first):`));
  for (const m of msgs) {
    const dot = m.seen ? '  ' : A.grn('● ');
    const when = m.date ? new Date(m.date).toISOString().slice(5, 16).replace('T', ' ') : '     ';
    console.log(`  ${dot}${A.bold('#' + m.uid)}\t${A.dim(when)}  ${pad(m.from, 26)} ${m.subject}`);
  }
  console.log(A.dim('\n  read: asmltr mail read <uid>   ·   search: asmltr mail search "<q>"'));
}
async function cmdDrafts(rest) {
  // asmltr drafts [list] | show <id> | send <id> | discard <id>
  const sub = rest[0];
  const coreJson = (p, method = 'GET') => fetch(CORE_BASE + p, { method, headers: { 'Content-Type': 'application/json' } }).then((x) => x.json()).catch((e) => ({ error: e.message }));
  if (sub === 'show') {
    const d = await coreJson('/v2/drafts/' + rest[1]);
    if (d.error) return console.log(A.red(d.error));
    console.log(A.bold(`draft #${d.id}`) + `  ${paint(d.channel, d.channel)} → ${d.recipient || '?'}${d.subject ? '  ' + A.dim(d.subject) : ''}  ${A.dim(d.status)}`);
    if (d.reason) console.log(A.dim('held: ' + d.reason));
    console.log('\n' + d.body + '\n');
    if (d.attachments && d.attachments.length) console.log(A.dim('attachments: ' + d.attachments.join(', ')));
    return;
  }
  if (sub === 'send' || sub === 'approve') {
    const r = await coreJson('/v2/drafts/' + rest[1] + '/approve', 'POST');
    return console.log(r.ok ? A.grn(`✓ sent draft #${r.sent}`) : A.red('send failed: ' + (r.error || '')));
  }
  if (sub === 'discard') {
    const r = await coreJson('/v2/drafts/' + rest[1] + '/discard', 'POST');
    return console.log(r.ok ? A.grn(`🗑  discarded draft #${r.discarded}`) : A.red('discard failed: ' + (r.error || '')));
  }
  const r = await coreJson('/v2/drafts?status=pending');
  const items = r.drafts || [];
  if (!items.length) return console.log(A.dim('no drafts awaiting approval'));
  console.log(A.bold(`drafts awaiting approval · ${items.length}:`));
  for (const d of items) {
    const when = new Date(d.created_at).toISOString().replace('T', ' ').slice(0, 16);
    console.log(`  ${A.bold('#' + d.id)} ${paint(d.channel, pad(d.channel, 9))} ${A.dim(when)} → ${d.recipient || '?'}${d.subject ? '  ' + d.subject : ''}`);
    console.log(`     ${A.dim(String(d.body).replace(/\s+/g, ' ').slice(0, 100))}`);
  }
  console.log(A.dim('\n  approve: asmltr drafts send <id>   ·   drop: asmltr drafts discard <id>   ·   full: drafts show <id>'));
}
async function cmdAnnouncements() {
  const r = await fetch(CORE_BASE + '/v2/announcements').then((x) => x.json()).catch((e) => ({ announcements: [], error: e.message }));
  const list = r.announcements || [];
  if (!list.length) return console.log(A.dim('no live announcements'));
  for (const a of list) {
    const ts = new Date(a.created_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const exp = a.expires_at ? A.dim(` (expires ${new Date(a.expires_at).toISOString().replace('T', ' ').slice(11, 16)})`) : '';
    console.log(`${A.dim('#' + a.id)} ${A.dim(ts)}  ${a.priority === 'urgent' ? A.red('[URGENT]') : ''} → ${a.target}${exp}\n   ${a.text}`);
  }
}
async function cmdKill(id, f) {
  if (!id) throw new Error('usage: asmltr kill <session_id> [--hard]');
  const r = await controlApi('/api/control/kill', 'POST', { session_id: id, hard: !!f.hard });
  console.log(r.ok ? A.grn(`killed ${id} (pid ${r.pid}, ${r.comm})`) : A.red('kill failed: ' + r.error));
}
async function cmdStop(id) {
  if (!id) throw new Error('usage: asmltr stop <session_id>');
  const r = await controlApi('/api/control/stop', 'POST', { session_id: id });
  console.log(r.ok ? A.grn(`SIGINT sent to ${id} (pid ${r.pid})`) : A.red('stop failed: ' + r.error));
}
async function cmdDiff(id) {
  if (!id) throw new Error('usage: asmltr diff <session_id>');
  const r = await fetch(BASE + '/api/control/diff?session_id=' + encodeURIComponent(id), { headers: controlHeaders }).then((x) => x.json());
  if (!r.ok) return console.log(A.red('diff: ' + r.error));
  console.log(A.dim(`# ${r.worktree}`)); console.log(r.diff || A.dim('(no changes)'));
}

function cmdHelp() {
  console.log(`${A.bold('asmltr')} — asmltr insights terminal client

  asmltr                 live TUI dashboard
  asmltr ls              list active sessions
  asmltr map             active sessions grouped by working dir (collision radar)
  asmltr who <path>      which sessions recently touched a file/dir
  asmltr brief           compact summary
  asmltr events [..]     recent events  (--surface --identity --session --limit)
  asmltr tail            live global event stream
  asmltr watch <key>     live stream for one session
  asmltr context <id>    condensed, readable transcript + status of a session by id
       [-n <events>] [--full]         (hand this to another session to pull its context)
  asmltr system          current system metrics
  ${A.bold('cross-channel:')}
  asmltr send <ch> <target> "<text>"   deliver a message OUT through any connector
       ... --file <path> [--caption T]  attach a FILE (image/PDF/any) on channels that support it
       ... --subject "<subj>"           set the subject (email)
  asmltr announce "<text>" [--to T]    post a cross-session announcement (--urgent, --ttl <sec>);
                                       delivered into other sessions' context on their next turn
  asmltr steer <key> "<guidance>"      push guidance into another session's LIVE turn (COERCIVE;
       [--from L] [--interrupt]         needs ASMLTR_MESH_STEER=on). Advisory alternative: announce
  asmltr announcements                 list live announcements (with timestamps)
  asmltr uploads [search]              files users sent on ANY channel (--channel --since 2h|1d --sender --limit)
       uploads get <id>                print the stored path of one upload
  asmltr drafts                        replies held for your approval (any connector)
       drafts show <id> · send <id> · discard <id>
  asmltr mail [list]                   browse the mailbox (-n N, --unseen)
       mail read <uid> [--seen] · mail search "<q>"
  ${A.bold('control / takeover:')}
  asmltr attach <key>    claim a channel session + resume it in tmux (attach/detach)
  asmltr release <key>   end a takeover; channel resumes
  asmltr kill <id>       SIGTERM an ephemeral session's pid (--hard = SIGKILL after grace)
  asmltr stop <id>       SIGINT an ephemeral session
  asmltr diff <id>       git diff of a session's worktree
  ${A.bold('sessions:')}
  asmltr claude [args]   launch a monitored, identity-anchored claude session (tmux; takeover-able)
  asmltr provision-alias create a \`<agent-name>\` → \`asmltr claude\` command (from ASSISTANT_NAME;
       [name] [--force]  conflict-checked — won't shadow an existing command). \`unalias\` to remove
  asmltr help

  collector: ${BASE}   core: ${CORE_BASE}   ${TOKEN ? '(token set)' : A.dim('(no token — dev mode)')}`);
}

// --- version + update --------------------------------------------------------
async function cmdVersion() {
  const v = require('../shared/version');
  const info = v.info();
  console.log(A.bold('asmltr ') + A.grn('v' + info.version) + '  ' + A.dim(info.sha + (info.tag ? ' · ' + info.tag : '') + ' · ' + info.channel + ' channel'));
  for (const [name, base] of [['core', CORE_BASE], ['collector', BASE], ['manager', MANAGER_BASE]]) {
    try { const r = await fetch(base + '/version').then((x) => x.json()); console.log('  ' + pad(name, 10) + 'v' + (r.version || '?') + '  ' + A.dim('sha ' + (r.sha || '?'))); }
    catch (_) { console.log('  ' + pad(name, 10) + A.dim('offline')); }
  }
  try {
    const u = await fetch(CORE_BASE + '/v2/update/status').then((x) => x.json());
    if (u && u.available) console.log(A.yel(`\n  update available: ${u.behind} commit(s) behind on ${u.channel} (${u.target}) — run: asmltr update`));
    else if (u && u.ok) console.log(A.dim(`\n  up to date on the ${u.channel} channel`));
  } catch (_) {}
}

async function cmdUpdate(rest, f) {
  const path = require('path');
  const has = (x) => rest.includes('--' + x);
  if (has('agent')) { // LLM escape-hatch updater (detached via core)
    const r = await fetch(CORE_BASE + '/v2/update/run?mode=agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'cli' }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    return console.log(r && r.ok ? A.grn(`agent update session started (pid ${r.pid}) — watch it in the dashboard`) : A.red('failed: ' + (r && r.error)));
  }
  const args = [path.join(__dirname, '..', 'scripts', 'update.js')];
  if (has('dry-run') || has('n')) args.push('--dry-run');
  if (has('force')) args.push('--force');
  const channel = f.channel || (has('stable') ? 'stable' : has('edge') ? 'edge' : null);
  if (channel) args.push('--channel', channel);
  args.push('--by', 'cli');
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exit(r.status || 0);
}

// asmltr silo <verb> — browse/search/read/write a data silo (default: the Self silo).
async function cmdSilo(rest, f) {
  const fs = require('fs');
  const silo = require('../shared/silo');
  const identity = require('../shared/identity');
  const verb = rest[0] || 'overview';
  const pos = rest.slice(1).filter((a) => !a.startsWith('--')); // positional args (flags stripped)
  const has = (name) => rest.includes('--' + name);            // boolean-flag presence

  if (verb === 'list' || verb === 'ls-silos') {
    const all = silo.list();
    if (!all.length) return console.log(A.dim('(no silos)'));
    for (const m of all) console.log(`${A.bold(m.id.padEnd(16))} ${A.dim('[' + m.type + ']')} ${m.name}`);
    return;
  }
  if (verb === 'new' || verb === 'create') {
    const id = pos[0]; if (!id) throw new Error('usage: asmltr silo new <id> [--name "..."] [--template <type>]');
    const s = silo.create({ id, name: f.name || id, type: f.template || f.type || 'generic' });
    return console.log('created silo ' + A.bold(id) + ' at ' + s.dir);
  }

  const s = f.silo ? silo.open(f.silo) : silo.ensureSelf(identity.name());
  switch (verb) {
    case 'overview': return console.log(JSON.stringify(await s.overview(), null, 2));
    case 'ls': {
      const es = await s.ls(pos[0] || '');
      if (!es.length) return console.log(A.dim('(empty)'));
      for (const e of es) console.log(`${e.type === 'dir' ? A.cyn('d') : ' '} ${e.path}`);
      return;
    }
    case 'tree': {
      const es = await s.tree(pos[0] || '', f.depth ? +f.depth : Infinity);
      for (const e of es) console.log(`${'  '.repeat(Math.max(0, e.path.split('/').length - 1))}${e.type === 'dir' ? A.cyn(e.path.split('/').pop() + '/') : e.path.split('/').pop()}`);
      return;
    }
    case 'find': {
      const r = await s.find(pos[0] || '', { in: f.in, type: f.type, since: f.since, content: has('content') });
      if (!r.length) return console.log(A.dim('(no matches)'));
      for (const x of r) console.log(`${A.dim((x.match || 'name').padEnd(12))} ${x.path}`);
      return;
    }
    case 'stat': return console.log(JSON.stringify(await s.stat(pos[0]), null, 2));
    case 'get': process.stdout.write(await s.get(pos[0])); return;
    case 'put': {
      const src = pos[1];
      const data = src ? fs.readFileSync(src) : fs.readFileSync(0); // 2nd arg = file, else stdin
      const r = await s.put(pos[0], data);
      return console.log('put ' + r.path + ' (' + r.size + ' bytes)');
    }
    case 'mkdir': await s.mkdir(pos[0]); return console.log('mkdir ' + pos[0]);
    case 'rm': await s.rm(pos[0]); return console.log('rm ' + pos[0]);
    case 'mv': await s.mv(pos[0], pos[1]); return console.log('mv ' + pos[0] + ' -> ' + pos[1]);
    default:
      console.log('asmltr silo <overview|ls|tree|find|get|put|stat|mkdir|rm|mv|new|list> [path] [args]');
      console.log(A.dim('  --silo <id>   operate on a named silo (default: the Self silo)'));
      console.log(A.dim('  find: --content (full-text) --type <ext> --since <date> --in <subpath>'));
  }
}

// asmltr backup <create|list|verify|restore> — encrypted, restorable snapshots (scripts/backup.js).
async function cmdBackup(rest, f) {
  const backup = require('../scripts/backup');
  const verb = rest[0] || 'list';
  const pos = rest.slice(1).filter((a) => !a.startsWith('--'));
  const log = (m) => console.log(A.dim(m));
  const opts = { passphrase: f.passphrase, label: f.label, out: f.out, log };
  switch (verb) {
    case 'create': { const r = await backup.createBackup(opts); console.log(`${A.grn('✓')} ${r.file} ${A.dim('(' + (r.bytes / 1048576).toFixed(2) + ' MB)')}`); return; }
    case 'list': {
      const all = backup.listBackups();
      if (!all.length) return console.log(A.dim('(no backups)'));
      for (const b of all) console.log(`${A.bold(b.name)}  ${A.dim((b.bytes / 1048576).toFixed(2) + ' MB')}`);
      return;
    }
    case 'verify': {
      const r = await backup.verifyBackup(pos[0], opts);
      if (r.ok) console.log(`${A.grn('✓')} ${r.manifest.version}/${r.manifest.label} @ ${new Date(r.manifest.created_at).toISOString()} ${A.dim('(' + r.checked + ' artifacts verified)')}`);
      else console.log(`${A.red('✗ integrity FAILED')} — ${r.mismatches.map((m) => m.file).join(', ')}`);
      return;
    }
    case 'restore': { await backup.restoreBackup(pos[0], { ...opts, dryRun: f['dry-run'] || f.n, activate: f.activate, force: f.force }); return; }
    default: console.log('asmltr backup <create|list|verify|restore> [file] [--label x] [--passphrase x] [--dry-run] [--activate] [--force] [--out path]');
  }
}

// asmltr vault <status|unseal|seal|init> — TRUST vault bootstrap + passphrase-unseal (shared/vault.js).
async function cmdVault(rest, f) {
  const fs = require('fs');
  const path = require('path');
  try { require('../shared/loadenv'); } catch (_) {} // pick up ASMLTR_VAULT_* from .env (real env still wins)
  const vault = require('../shared/vault');
  const identity = require('../shared/identity');
  const verb = rest[0] || 'status';
  const ENV = path.join(__dirname, '..', '.env');

  // Upsert KEY=value into .env (replaces an existing active line; leaves comments alone).
  const upsertEnv = (kv) => {
    let lines = [];
    try { lines = fs.readFileSync(ENV, 'utf8').split('\n'); } catch (_) {}
    for (const [k, v] of Object.entries(kv)) {
      const i = lines.findIndex((l) => l.replace(/^\s*(export\s+)?/, '').startsWith(k + '='));
      if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`);
    }
    fs.writeFileSync(ENV, lines.join('\n'));
  };

  if (verb === 'status') {
    const h = await vault.health(); const s = await vault.sealStatus();
    console.log(`vault:  ${h.ok ? A.grn('reachable') : A.red('unreachable')}${h.error ? A.dim(' (' + h.error + ')') : ''}`);
    console.log(`sealed: ${s.sealed ? A.yel('yes — credential ops locked') : A.grn('no')}${s.vault_initialized != null ? A.dim(' · initialized: ' + s.vault_initialized) : ''}`);
    return;
  }
  if (verb === 'unseal') {
    const pw = f.passphrase || f.password || rest[1] || process.env.ASMLTR_VAULT_PASSWORD || process.env.TRUST_PROTOCOL_VAULT_PASSWORD;
    if (!pw) throw new Error('unseal needs a passphrase: asmltr vault unseal <passphrase>');
    const r = await vault.unseal(pw);
    console.log(A.grn('✓') + ' ' + ((r && r.message) || 'unsealed'));
    return;
  }
  if (verb === 'seal') { await vault.seal(); console.log(A.grn('✓') + ' sealed'); return; }
  if (verb === 'init') {
    if (f.url) process.env.ASMLTR_VAULT_URL = f.url;
    if (f['admin-key']) process.env.ASMLTR_VAULT_ADMIN_KEY = f['admin-key'];
    const url = process.env.ASMLTR_VAULT_URL || 'http://127.0.0.1:9500/v1';
    console.log('vault url: ' + A.dim(url));
    const h = await vault.health();
    if (!h.ok) {
      console.log(A.red('✗ vault not reachable at ' + url));
      console.log('  Deploy the TRUST Protocol first (a separate service on :9500):');
      console.log('    ' + A.dim('https://github.com/jarethmt/trust-protocol') + '  ·  docs: security/trust-vault');
      console.log('  Then re-run: ' + A.bold('asmltr vault init --url <url> --admin-key <key> [--unseal <passphrase>]'));
      process.exit(1);
    }
    const s = await vault.sealStatus();
    if (s.sealed) {
      const pw = f.unseal || process.env.ASMLTR_VAULT_PASSWORD || process.env.TRUST_PROTOCOL_VAULT_PASSWORD;
      if (!pw) { console.log(A.yel('vault is SEALED') + ' — re-run with --unseal <passphrase>.'); process.exit(1); }
      await vault.unseal(pw); console.log(A.grn('✓') + ' unsealed');
    }
    if (!process.env.ASMLTR_VAULT_ADMIN_KEY) throw new Error('need an admin key: --admin-key <key> (or ASMLTR_VAULT_ADMIN_KEY)');
    const name = identity.name();
    console.log('registering SACRED agent: ' + A.bold(name));
    const agent = await vault.ensureAgent(name);
    const env = { ASMLTR_VAULT_URL: url };
    if (f['admin-key']) env.ASMLTR_VAULT_ADMIN_KEY = f['admin-key'];
    if (agent.created) { env.ASMLTR_VAULT_AGENT_KEY = agent.api_key; process.env.ASMLTR_VAULT_AGENT_KEY = agent.api_key; console.log(A.grn('✓') + ' agent registered (SACRED)'); }
    else console.log(A.dim('· agent already exists (agent key unchanged; re-register to rotate)'));
    upsertEnv(env);
    console.log(A.grn('✓') + ' wrote ' + Object.keys(env).join(', ') + ' → .env');
    if (process.env.ASMLTR_VAULT_AGENT_KEY) {
      const t = 'asmltr_init_selftest';
      try {
        await vault.storeSecret(t, { value: 'ok' }, { minTrust: 'SACRED' });
        const got = await vault.getSecret(t);
        await vault.deleteSecret(t);
        console.log(got && got.value === 'ok' ? A.grn('✓ roundtrip verified (store → proxy-fetch → delete)') : A.yel('· roundtrip returned an unexpected value'));
      } catch (e) { console.log(A.yel('· roundtrip check skipped: ' + e.message)); }
    } else console.log(A.dim('· skipped roundtrip (no agent key — re-register to rotate one in)'));
    console.log('\n' + A.bold('Next:') + ' restart services — ' + A.dim('pm2 restart asmltr-core asmltr-connector-manager asmltr-insights-collector'));
    return;
  }
  console.log('asmltr vault <status|unseal|seal|init> [--url <u>] [--admin-key <k>] [--unseal <passphrase>]');
}

// --- main --------------------------------------------------------------------
(async () => {
  const [, , cmd, ...rest] = process.argv;
  const f = flags(rest);
  try {
    switch (cmd) {
      case undefined:
      case 'top': return require('./tui').run(BASE, CORE_BASE, TOKEN, A, { base: MANAGER_BASE, token: MANAGER_TOKEN });
      case 'claude': case 'gemini': case 'codex': { // launch an interactive reasoning-engine session (monitored + takeover-able)
        const r = spawnSync(process.execPath, [require('path').join(__dirname, 'asmltr-engine.js'), cmd, ...rest], { stdio: 'inherit' });
        return process.exit(r.status || 0);
      }
      case 'provision-alias': { // create a `<agent-name>` → `asmltr claude` command shim (conflict-checked)
        try { require('../shared/loadenv'); } catch (_) {} // so ASSISTANT_NAME resolves from .env
        const alias = require('../shared/alias');
        const force = rest.includes('--force') || rest.includes('-f');
        const named = rest.find((a) => !a.startsWith('-'));
        const r = alias.provisionAlias({ name: named, force });
        if (!r.ok) { console.error(A.red('✗ ' + r.error)); return process.exit(1); }
        console.log(A.grn(`✓ '${r.alias}' → ${r.target}`) + A.dim(`  (${r.path}${r.replacedOwn ? ', refreshed' : ''})`));
        if (r.warning) console.log(A.yel('  ⚠ ' + r.warning));
        return;
      }
      case 'unalias': {
        const r = require('../shared/alias').removeAlias(rest.find((a) => !a.startsWith('-')));
        console.log(r.ok ? A.grn('✓ removed ' + r.removed) : A.yel('· ' + r.error));
        return;
      }
      case 'ls': return await cmdLs();
      case 'map': return await cmdMap();
      case 'who': return await cmdWho(rest);
      case 'brief': return await cmdBrief();
      case 'events': return await cmdEvents(f);
      case 'system': return await cmdSystem();
      case 'tail': return liveStream(null);
      case 'watch': return liveStream(rest[0]);
      case 'context': case 'transcript': return await cmdContext(rest);
      case 'send': return await cmdSend(rest);
      case 'announce': return await cmdAnnounce(rest);
      case 'announcements': return await cmdAnnouncements();
      case 'uploads': return await cmdUploads(rest);
      case 'drafts': return await cmdDrafts(rest);
      case 'mail': return await cmdMail(rest);
      case 'steer': return await cmdSteer(rest);
      case 'attach': return await cmdAttach(rest[0], f);
      case 'release': return await cmdRelease(rest[0]);
      case 'kill': return await cmdKill(rest[0], f);
      case 'stop': return await cmdStop(rest[0]);
      case 'diff': return await cmdDiff(rest[0]);
      case 'update': return await cmdUpdate(rest, f);
      case 'silo': return await cmdSilo(rest, f);
      case 'backup': return await cmdBackup(rest, f);
      case 'vault': return await cmdVault(rest, f);
      case 'version': case '--version': return await cmdVersion();
      case 'help': case '--help': case '-h': return cmdHelp();
      default: console.error(`unknown command: ${cmd}\n`); return cmdHelp();
    }
  } catch (err) {
    console.error(A.red('error: ') + err.message);
    if (/ECONNREFUSED|fetch failed/.test(err.message)) console.error(A.dim(`is the collector running? (${BASE})`));
    process.exit(1);
  }
})();
