#!/usr/bin/env node
'use strict';
/**
 * `asmltr <engine> [args…]` (engine = claude | gemini | codex | grok) — launch an interactive session of a
 * reasoning-engine CLI harness inside a multiplexer (tmux/screen), so it is monitored in the asmltr
 * dashboard and can be steered / attached ("taken over"). Generalizes the original `asmltr claude`.
 *
 *   1. Start `<engine-bin> <args>` in a DETACHED tmux/screen session (attach/detachable, survives you).
 *   2. Register it in the tracker JSON → it appears as a `<engine>-cli` session card in the dashboard.
 *   3. (Claude only, for now) spawn a transcript tailer so the details pane is live. Other engines are
 *      tracked + attachable; deep per-engine transcript streaming is a follow-on.
 *   4. Attach you. Detach leaves it running + monitored; quitting the CLI ends it.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
try { require('../shared/loadenv'); } catch (_) {}
const engines = require('../shared/engines');
const mux = require('../shared/mux');

const HOME = os.homedir();
const TRACKER = process.env.ASMLTR_CLI_TRACKER_PATH || path.join(HOME, '.asmltr', 'cli-sessions.json');
const IDENTITY = process.env.ASMLTR_CLI_IDENTITY || (os.userInfo().username || 'cli');

function readTracker() { try { return JSON.parse(fs.readFileSync(TRACKER, 'utf8')); } catch { return { sessions: [] }; } }
function writeTracker(t) { fs.mkdirSync(path.dirname(TRACKER), { recursive: true }); fs.writeFileSync(TRACKER, JSON.stringify(t)); }
function upsert(entry) {
  const t = readTracker();
  const i = t.sessions.findIndex((s) => s.session_id === entry.session_id);
  if (i >= 0) t.sessions[i] = { ...t.sessions[i], ...entry }; else t.sessions.push(entry);
  writeTracker(t);
}

// Per-engine launch profile — how to make it autonomous + how (if at all) to inject the identity prompt.
function profile(id, cwd) {
  const cfg = engines.config(id);
  const extra = Array.isArray(cfg.launch_args) ? cfg.launch_args : [];
  if (id === 'claude') {
    let perm = 'bypassPermissions';
    try { perm = require('../shared/runtime').getCliPermissionMode(); } catch (_) {}
    const selfAware = process.env.ASMLTR_SELF_AWARE !== 'off';
    const TOOLBELT = '## ASMLTR TOOLBELT\nRun `asmltr help` for cross-session tools: `asmltr ls`, ' +
      '`asmltr send <channel> <target> "<text>"`, `asmltr announce "<text>"` / `asmltr announcements`.';
    let appended = ''; try { appended = selfAware ? require('../shared/identity').assemble({ cwd, extra: TOOLBELT }) : ''; } catch (_) {}
    return {
      surface: 'claude-code',
      envPrefix: perm === 'bypassPermissions' ? 'export IS_SANDBOX=1; ' : '',
      args: [...(perm && perm !== 'default' ? ['--permission-mode', perm] : []), ...(appended ? ['--append-system-prompt', appended] : []), ...extra],
      tailer: 'claude-tailer.js',
    };
  }
  const model = engines.modelFor(id);
  if (id === 'gemini') return { surface: 'gemini-cli', envPrefix: '', args: ['--yolo', ...(model ? ['-m', model] : []), ...extra], tailer: null };
  if (id === 'codex') return { surface: 'codex-cli', envPrefix: '', args: [...(model ? ['-m', model] : []), ...extra], tailer: null };
  if (id === 'grok') return { surface: 'grok-cli', envPrefix: '', args: ['--always-approve', ...(model ? ['-m', model] : []), ...extra], tailer: null };
  return { surface: id + '-cli', envPrefix: '', args: extra, tailer: null };
}

async function main() {
  const id = process.argv[2];
  const args = process.argv.slice(3);
  if (!engines.known(id)) { console.error(`asmltr: unknown engine "${id}" (known: ${Object.keys(engines.ENGINES).join(', ')})`); process.exit(2); }

  // API-key auth: pull the key from the vault and put it in this process's env so the harness (and the
  // tmux/screen session it inherits) sees it. Subscription mode needs nothing (the CLI owns its login).
  try { Object.assign(process.env, await engines.envForLaunch(id)); } catch (_) { /* vault unreachable → fall through to whatever env exists */ }

  const bin = engines.resolveBin(id);
  if (!bin) {
    console.error(`asmltr ${id}: could not find the \`${id}\` executable on PATH.`);
    console.error(`  Install it (${engines.ENGINES[id].installHint || engines.ENGINES[id].pkg || engines.ENGINES[id].install || id}) or set ${engines.ENGINES[id].binEnv} to its full path, then retry.`);
    process.exit(127);
  }

  const MUX = mux.current();
  if (!mux.available(MUX)) { console.error(`asmltr ${id}: no terminal multiplexer found — install tmux or screen (or set ASMLTR_MULTIPLEXER).`); process.exit(1); }
  const M = mux.provider(MUX);

  const cwd = process.cwd();
  const launchTs = Date.now();
  const name = `asmltr-cli-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const p = profile(id, cwd);

  // Lingers on non-zero exit so a broken launch is visible on attach instead of a vanished pane.
  const guard = p.envPrefix + '"$0" "$@"; ec=$?; if [ $ec -ne 0 ]; then echo; echo "[asmltr] ' + id + ' exited with code $ec (see above); this pane closes in 30s"; sleep 30; fi';
  if (!M.spawnDetached(name, cwd, ['bash', '-c', guard, bin, ...p.args, ...args])) { console.error(`asmltr ${id}: failed to start ${MUX} session`); process.exit(1); }

  upsert({
    session_id: name, surface: p.surface, engine: id, identity: IDENTITY,
    multiplexer: MUX, tmux_target: name, pid: M.pid(name),
    cwd, working_dir: cwd, task: `${id} — ${path.basename(cwd)}`,
    started_unix: Math.floor(launchTs / 1000), last_activity_unix: Math.floor(launchTs / 1000),
    tool_count: 0, status: 'active',
  });

  if (p.tailer) {
    const child = spawn(process.execPath, [path.join(__dirname, 'lib', p.tailer), name, cwd, name, String(launchTs)], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  }

  console.log(`▶ asmltr: monitoring this ${id} session as \x1b[36m${name}\x1b[0m (dashboard → Live).`);
  console.log(`  detach with ${M.detachHint} (keeps running + monitored) · re-attach: ${M.attachCmd(name)}\n`);
  M.attach(name);

  if (!M.alive(name)) {
    const t = readTracker(); const s = t.sessions.find((x) => x.session_id === name);
    if (s) { s.status = 'ended'; s.last_activity_unix = Math.floor(Date.now() / 1000); writeTracker(t); }
    console.log(`\n✓ session ${name} ended.`);
  } else {
    console.log(`\n↩ detached — ${name} still running and monitored. Re-attach: ${M.attachCmd(name)}`);
  }
}

main().catch((e) => { console.error('asmltr:', e.message); process.exit(1); });
