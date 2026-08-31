'use strict';
/**
 * The scheduler — the core's in-process tick that fires due jobs from shared/schedules.js. This is
 * asmltr's replacement for the retired `claude -p` wake-up crontab: a **prompt** job runs a real
 * managed turn through the core pipeline (so the session is tracked and never leaks), and a **shell**
 * job runs a host command (cron parity). See docs/SCHEDULES.md.
 *
 * Kept out of server.js so the firing logic is small and testable; server.js wires it with `handle`.
 */
const { spawn } = require('child_process');
const schedules = require('../../shared/schedules');
const sessions = require('./sessions');
const trust = require('./trust/store');

const SCHEDULER_SURFACE = 'schedule';
const SCHEDULER_VALUE = 'scheduler';
const SCHEDULER_PID = 'scheduler'; // trust principal id

/**
 * Ensure an internal, fully-trusted "Scheduler" principal exists (idempotent). A scheduled prompt was
 * authored by the operator in the owner-only, 2FA-gated dashboard, so it runs at operator trust with
 * moderation bypassed — the same standing a terminal command has. Identified by (surface,value)=
 * (schedule,scheduler); no external connector uses the `schedule` surface, so this can't be spoofed.
 */
function ensureSchedulerPrincipal() {
  try {
    const existing = trust.resolve({ channel: SCHEDULER_SURFACE, sender: { raw_id: SCHEDULER_VALUE } });
    if (existing && !existing.is_default) return; // already seeded
    try { trust.principals.create({ id: SCHEDULER_PID, display_name: 'Scheduler', default_tier: 5, notes: 'internal — fires scheduled prompt jobs' }); } catch (_) {}
    try { trust.identifiers.add(SCHEDULER_PID, SCHEDULER_SURFACE, SCHEDULER_VALUE); } catch (_) {}
    try { trust.grants.create({ principal_id: SCHEDULER_PID, allow: ['*'], bypass_moderation: true }); } catch (_) {}
  } catch (_) { /* trust store not ready — jobs still run, just at default trust */ }
}

/** Run one prompt job through the full core pipeline. Returns the assistant's reply text (for last_output). */
async function runPrompt(job, handle) {
  // session: "new" (default) → schedule:<id>, reset each run. Only schedule:* keys are allowed (V37).
  const key = schedules.promptConversationKey(job);
  const fresh = key === `schedule:${job.id}`;
  if (fresh) { try { sessions.remove(key); } catch (_) {} }
  const envelope = {
    channel: SCHEDULER_SURFACE,
    conversation_key: key,
    sender: { raw_id: SCHEDULER_VALUE, raw_username: 'Scheduler' },
    content: { text: job.prompt },
    delivery: 'async',
    channel_context: { schedule_id: job.id, schedule_name: job.name },
  };
  const actions = await handle(envelope, { engine: job.engine || undefined });
  const text = (actions || []).filter((a) => a && (a.type === 'reply' || a.type === 'status') && a.text)
    .map((a) => a.text).join('\n').trim();
  return text || '(no reply text)';
}

/** Run one shell job. Resolves to { status, output } — never rejects (errors become status:'error'). */
function runShell(job) {
  return new Promise((resolve) => {
    const cmd = job.command || (job.script_path ? `"${job.script_path}"` : '');
    if (!cmd) return resolve({ status: 'error', output: 'no command or script_path' });
    const timeoutMs = (job.timeout_s || 300) * 1000;
    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd: job.cwd || process.env.HOME || process.cwd(),
      env: process.env,
    });
    let out = '';
    const cap = (d) => { out += d.toString(); if (out.length > 200000) out = out.slice(-200000); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    if (killer.unref) killer.unref();
    child.on('error', (e) => { clearTimeout(killer); resolve({ status: 'error', output: (out + '\n' + e.message).trim() }); });
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      const status = code === 0 ? 'ok' : 'error';
      const tail = signal ? `\n[killed: ${signal} — timed out after ${job.timeout_s || 300}s]` : `\n[exit ${code}]`;
      resolve({ status, output: (out + tail).trim() });
    });
  });
}

/**
 * Start the scheduler tick. Returns { stop, tickOnce } so tests can drive it deterministically.
 *   handle(envelope, opts) — the core turn entrypoint (injected to avoid a require cycle with server.js).
 *   log(msg)               — progress line (optional).
 *   intervalMs             — tick cadence (default 30s).
 */
function start({ handle, log = () => {}, intervalMs = 30000 } = {}) {
  if (typeof handle !== 'function') throw new Error('scheduler needs a handle(envelope, opts) function');
  ensureSchedulerPrincipal();
  const inflight = new Set(); // per-job concurrency guard — a slow job never overlaps itself

  async function runJob(job) {
    if (inflight.has(job.id)) return; // still running from a prior tick — skip
    inflight.add(job.id);
    const startedAt = Date.now();
    try {
      log(`▶ ${job.type} job "${job.name}" (${job.id})`);
      let res;
      if (job.type === 'prompt') res = { status: 'ok', output: await runPrompt(job, handle) };
      else res = await runShell(job);
      schedules.markRan(job.id, { status: res.status, output: res.output, ranAtMs: startedAt });
      log(`✔ "${job.name}" ${res.status} (${Date.now() - startedAt}ms)`);
    } catch (e) {
      schedules.markRan(job.id, { status: 'error', error: e.message, ranAtMs: startedAt });
      log(`✖ "${job.name}" error: ${e.message}`);
    } finally {
      inflight.delete(job.id);
    }
  }

  async function tickOnce() {
    let due;
    try { due = schedules.dueJobs(); } catch (_) { return; }
    for (const job of due) runJob(job); // fire-and-forget; each guards its own concurrency
  }

  const timer = setInterval(() => { tickOnce().catch(() => {}); }, intervalMs);
  if (timer.unref) timer.unref();
  return { stop: () => clearInterval(timer), tickOnce, runJob };
}

module.exports = { start, runPrompt, runShell, ensureSchedulerPrincipal, SCHEDULER_SURFACE };
