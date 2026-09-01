#!/usr/bin/env node
'use strict';
/**
 * `asmltr claude [args…]` — launch an interactive `claude` session inside a multiplexer (tmux or screen) so it is
 * monitored in the asmltr dashboard (live conversation history) and can be steered
 * (inject), interrupted, or attached ("taken over") from the dashboard/TUI.
 *
 * How it works:
 *   1. Start `claude <args>` in a DETACHED tmux session (attach/detachable, survives you).
 *   2. Register it in a tracker JSON the collector reconciles → it appears as a
 *      `claude-code` session card in the dashboard.
 *   3. Spawn a detached transcript tailer that streams the session's ~/.claude jsonl into
 *      the collector as inbound/thinking/tool/outbound events (so the details pane is live).
 *   4. Attach you to the tmux session. Detach (Ctrl-b d) leaves it running + monitored;
 *      quitting claude ends it. Others can take over with `tmux attach -t <target>`.
 */
const { spawnSync, spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
try { require('../shared/loadenv'); } catch (_) {}

const HOME = os.homedir();
const TRACKER = process.env.ASMLTR_CLI_TRACKER_PATH || path.join(HOME, '.asmltr', 'cli-sessions.json');
const IDENTITY = process.env.ASMLTR_CLI_IDENTITY || (os.userInfo().username || 'cli');

function haveTmux() { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } }
function isExecFile(p) { try { const st = fs.statSync(p); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } }
// Resolve a REAL claude executable — scans PATH for a regular executable file (so a stray
// directory named `claude` on PATH is skipped), then known install locations. Override with
// ASMLTR_CLAUDE_BIN.
function resolveClaude() {
  const envBin = process.env.ASMLTR_CLAUDE_BIN;
  if (envBin) return isExecFile(envBin) ? envBin : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && isExecFile(path.join(dir, 'claude'))) return path.join(dir, 'claude');
  }
  for (const c of ['/usr/local/bin/claude', '/usr/bin/claude', path.join(HOME, '.claude/local/claude'), path.join(HOME, '.local/bin/claude')]) {
    if (isExecFile(c)) return c;
  }
  return null;
}
function readTracker() { try { return JSON.parse(fs.readFileSync(TRACKER, 'utf8')); } catch { return { sessions: [] }; } }
function writeTracker(t) { fs.mkdirSync(path.dirname(TRACKER), { recursive: true }); fs.writeFileSync(TRACKER, JSON.stringify(t)); }
function upsert(entry) {
  const t = readTracker();
  const i = t.sessions.findIndex((s) => s.session_id === entry.session_id);
  if (i >= 0) t.sessions[i] = { ...t.sessions[i], ...entry }; else t.sessions.push(entry);
  writeTracker(t);
}
const mux = require('../shared/mux');

function main() {
  const MUX = mux.current();      // 'screen' | 'tmux' (ASMLTR_MULTIPLEXER, default screen; screen = native mouse-wheel scrollback)
  const M = mux.provider(MUX);
  if (!mux.available(MUX)) { console.error('asmltr claude: no terminal multiplexer found — install tmux or screen (or set ASMLTR_MULTIPLEXER).'); process.exit(1); }
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const name = `asmltr-cli-${stamp}`;
  const launchTs = Date.now();

  // Resolve claude up front so we fail loudly (not with a dead tmux pane) if it's missing.
  const claudeBin = resolveClaude();
  if (!claudeBin) {
    console.error('asmltr claude: could not find a working `claude` executable on PATH.');
    console.error('  Install Claude Code, or set ASMLTR_CLAUDE_BIN to its full path, then retry.');
    process.exit(127);
  }

  // Permission mode for this session (default 'bypassPermissions' = full-autonomy, GUI/TUI-toggleable
  // via shared/runtime). As root the modern CLI rejects --dangerously-skip-permissions; the sanctioned
  // full-autonomy path is --permission-mode bypassPermissions + IS_SANDBOX=1 (verified).
  let permMode = 'bypassPermissions';
  try { permMode = require('../shared/runtime').getCliPermissionMode(); } catch (_) {}
  const permArgs = permMode && permMode !== 'default' ? ['--permission-mode', permMode] : [];
  const envPrefix = permMode === 'bypassPermissions' ? 'export IS_SANDBOX=1; ' : '';

  // Detached tmux session running claude via a tiny shell that LINGERS on failure — so if
  // claude exits non-zero (e.g. a broken install), you attach and actually see the error
  // instead of a session that vanished. On a normal exit the pane closes and the session ends.
  const guard = envPrefix + '"$0" "$@"; ec=$?; if [ $ec -ne 0 ]; then echo; echo "[asmltr] claude exited with code $ec (see above); this pane closes in 30s"; sleep 30; fi';
  // Assemble the appended system prompt: IDENTITY anchor (who you are — the Likeness self-attestation)
  // + pluggable CONTEXT (the assistant's own injected startup context, via ASMLTR_CLAUDE_CONTEXT_CMD /
  // ~/.asmltr/context.d) + the asmltr TOOLBELT note. Disable the whole block with ASMLTR_SELF_AWARE=off.
  const selfAware = process.env.ASMLTR_SELF_AWARE !== 'off';
  const TOOLBELT = '## ASMLTR TOOLBELT\nRun `asmltr help` for cross-session tools: `asmltr ls` (other active ' +
    'sessions — avoid duplicating their work), `asmltr send <channel> <target> "<text>"` (route output to ' +
    'another channel), `asmltr announce "<text>"` / `asmltr announcements` (awareness notes across sessions), ' +
    '`asmltr bounce` (restart last — never inline from a live turn).';
  const appended = selfAware ? require('../shared/identity').assemble({ cwd, extra: TOOLBELT }) : '';
  const claudeArgs = [...permArgs, ...(appended ? ['--append-system-prompt', appended] : []), ...args];
  const ok = M.spawnDetached(name, cwd, ['bash', '-c', guard, claudeBin, ...claudeArgs]);
  if (!ok) { console.error(`asmltr claude: failed to start ${MUX} session`); process.exit(1); }

  const pid = M.pid(name);
  upsert({
    session_id: name, surface: 'claude-code', identity: IDENTITY,
    multiplexer: MUX, tmux_target: name, pid,
    cwd, working_dir: cwd, task: `claude — ${path.basename(cwd)}`,
    started_unix: Math.floor(launchTs / 1000), last_activity_unix: Math.floor(launchTs / 1000),
    tool_count: 0, status: 'active',
  });

  // Detached transcript tailer: discovers the session's jsonl + streams events to the collector.
  const tailer = path.join(__dirname, 'lib', 'claude-tailer.js');
  const child = spawn(process.execPath, [tailer, name, cwd, name, String(launchTs)], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  child.unref();

  console.log(`▶ asmltr: monitoring this claude session as \x1b[36m${name}\x1b[0m (dashboard → Live).`);
  console.log(`  detach with ${M.detachHint} (keeps running + monitored) · re-attach: ${M.attachCmd(name)}\n`);

  // Attach (foreground). Returns on detach or when claude exits.
  M.attach(name);

  if (!M.alive(name)) {
    // claude exited → mark ended (the tailer also notices and flushes).
    const t = readTracker();
    const s = t.sessions.find((x) => x.session_id === name);
    if (s) { s.status = 'ended'; s.last_activity_unix = Math.floor(Date.now() / 1000); writeTracker(t); }
    console.log(`\n✓ session ${name} ended.`);
  } else {
    console.log(`\n↩ detached — ${name} still running and monitored. Re-attach: ${M.attachCmd(name)}`);
  }
}

main();
