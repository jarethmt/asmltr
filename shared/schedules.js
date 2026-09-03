'use strict';
/**
 * Schedules — "cron with a GUI" for asmltr. A persisted table of jobs that fire on a schedule, each
 * either an LLM **prompt** (a real managed turn through the core, NOT `claude -p` → no session leak)
 * or a **shell** command/script (host cron parity). This module is PURE store + schedule math; the
 * core owns the tick that actually fires due jobs (see core/src/server.js). See docs/SCHEDULES.md.
 *
 * Store: ~/.asmltr/schedules.json (gitignored), override with $ASMLTR_SCHEDULES_FILE.
 *
 * A schedule is normalized to a standard 5-field cron string `minute hour day-of-month month day-of-week`.
 * The GUI's friendly picker (time-of-day + weekdays) compiles to cron here; an advanced raw-cron field
 * passes straight through. Everything downstream evaluates cron uniformly — one code path, testable.
 * Cron is evaluated in the server's LOCAL time (document this in the UI).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function file() { return process.env.ASMLTR_SCHEDULES_FILE || path.join(os.homedir(), '.asmltr', 'schedules.json'); }

function readAll() {
  try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); return Array.isArray(j.jobs) ? j.jobs : []; }
  catch (_) { return []; }
}
function writeAll(jobs) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs }, null, 2));
  fs.renameSync(tmp, f); // atomic-ish replace
  return jobs;
}

// ── cron: compile friendly → cron, parse, match, next-run ───────────────────────

const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Normalize a schedule spec to a cron string.
 *   { cron: "0 8 * * 1-5" }                      → passthrough (validated)
 *   { time: "08:00", weekdays: [1,2,3,4,5] }     → "0 8 * * 1,2,3,4,5"   (empty/absent weekdays = every day)
 *   { time: "08:00", days: ["mon","tue"] }       → weekday names accepted too
 *   { every_minutes: 15 }                        → "* / 15 * * * *"
 */
function toCron(spec) {
  if (spec == null) throw new Error('schedule required');
  if (typeof spec === 'string') return validateCron(spec);
  if (spec.cron) return validateCron(String(spec.cron).trim());
  if (spec.every_minutes) {
    const n = Math.max(1, Math.min(59, parseInt(spec.every_minutes, 10) || 0));
    return validateCron(`*/${n} * * * *`);
  }
  if (spec.time) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(spec.time).trim());
    if (!m) throw new Error(`bad time "${spec.time}" (want HH:MM)`);
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (hh > 23 || mm > 59) throw new Error(`time out of range "${spec.time}"`);
    let wd = Array.isArray(spec.weekdays) ? spec.weekdays.slice()
      : Array.isArray(spec.days) ? spec.days.slice() : [];
    wd = wd.map((d) => (typeof d === 'string' ? DOW[d.slice(0, 3).toLowerCase()] : parseInt(d, 10)))
           .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    const dow = wd.length ? [...new Set(wd)].sort((a, b) => a - b).join(',') : '*';
    return validateCron(`${mm} ${hh} * * ${dow}`);
  }
  throw new Error('unrecognized schedule spec');
}

/** Parse one cron field into a Set of allowed ints over [min,max]; supports * , - and * / step and n/step. */
function parseField(field, min, max) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    const p = part.trim();
    if (!p) continue;
    let step = 1, range = p;
    const slash = p.indexOf('/');
    if (slash >= 0) { step = parseInt(p.slice(slash + 1), 10); range = p.slice(0, slash); if (!(step >= 1)) throw new Error(`bad step in "${part}"`); }
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.indexOf('-') > 0) { const [a, b] = range.split('-'); lo = parseInt(a, 10); hi = parseInt(b, 10); }
    else { lo = hi = parseInt(range, 10); }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`bad cron field "${field}"`);
    if (lo < min || hi > max || lo > hi) throw new Error(`cron field "${field}" out of range [${min}-${max}]`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (!out.size) throw new Error(`empty cron field "${field}"`);
  return out;
}

/** Split + validate a 5-field cron string; returns the trimmed canonical form (throws on malformed). */
function validateCron(cron) {
  const f = String(cron).trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron must have 5 fields, got ${f.length}: "${cron}"`);
  parseCron(cron); // throws if any field is bad
  return f.join(' ');
}

function parseCron(cron) {
  const [mi, ho, dom, mo, dow] = String(cron).trim().split(/\s+/);
  return {
    minute: parseField(mi, 0, 59),
    hour: parseField(ho, 0, 23),
    dom: parseField(dom, 1, 31), domStar: dom.trim() === '*',
    month: parseField(mo, 1, 12),
    dow: parseField(dow, 0, 6), dowStar: dow.trim() === '*',
  };
}

/** Does `date` (local time) match the cron? Standard cron DOM/DOW rule: if BOTH are restricted, match EITHER. */
function matches(cron, date) {
  const c = parseCron(cron);
  if (!c.minute.has(date.getMinutes())) return false;
  if (!c.hour.has(date.getHours())) return false;
  if (!c.month.has(date.getMonth() + 1)) return false;
  const domOk = c.dom.has(date.getDate());
  const dowOk = c.dow.has(date.getDay());
  if (c.domStar && c.dowStar) return true;         // both unrestricted
  if (c.domStar) return dowOk;                     // only DOW restricts
  if (c.dowStar) return domOk;                     // only DOM restricts
  return domOk || dowOk;                           // both restrict → OR (POSIX cron)
}

/**
 * Next fire time strictly after `fromMs` (default now), scanning minute-by-minute up to `capDays`
 * (default 366 — covers any real schedule; returns null if none, e.g. an impossible cron).
 */
function nextRun(cron, fromMs, capDays) {
  parseCron(cron); // validate once up front
  const cap = (capDays || 366) * 24 * 60;
  const d = new Date(typeof fromMs === 'number' ? fromMs : Date.now());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after the current minute
  for (let i = 0; i < cap; i++) {
    if (matches(cron, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// ── job CRUD ─────────────────────────────────────────────────────────────────

const VALID_TYPES = new Set(['prompt', 'shell']);

/** V37: prompt jobs may only use a fresh schedule session — never Discord/email/other keys. */
function normalizePromptSession(raw) {
  if (raw == null) return 'new';
  const s = String(raw).trim();
  if (!s || s === 'new') return 'new';
  if (/^schedule:[A-Za-z0-9_.-]+$/.test(s)) return s;
  throw new Error('session must be "new" or schedule:<id> — cannot target Discord/email/other conversation keys');
}

function promptConversationKey(job) {
  const id = job && job.id ? String(job.id) : 'unknown';
  try {
    const s = normalizePromptSession(job && job.session);
    return s === 'new' ? `schedule:${id}` : s;
  } catch (_) {
    return `schedule:${id}`;
  }
}

function sanitize(job, existing) {
  const j = { ...(existing || {}) };
  if (job.name != null) j.name = String(job.name).slice(0, 200);
  if (job.enabled != null) j.enabled = !!job.enabled;
  if (job.type != null) { if (!VALID_TYPES.has(job.type)) throw new Error(`type must be prompt|shell`); j.type = job.type; }
  if (job.schedule != null) { j.cron = toCron(job.schedule); j.schedule = job.schedule; } // keep raw spec for the editor
  else if (job.cron != null) { j.cron = validateCron(job.cron); j.schedule = { cron: j.cron }; }
  // type-specific payload
  if (job.type === 'prompt' || j.type === 'prompt') {
    if (job.prompt != null) j.prompt = String(job.prompt);
    if (job.engine != null) j.engine = job.engine || null;   // null/'' = default engine
    if (job.session != null) j.session = normalizePromptSession(job.session);
  }
  if (job.type === 'shell' || j.type === 'shell') {
    if (job.command != null) j.command = String(job.command);
    if (job.script_path != null) j.script_path = String(job.script_path);
    if (job.cwd != null) j.cwd = job.cwd ? String(job.cwd) : null;
    if (job.timeout_s != null) j.timeout_s = Math.max(1, Math.min(3600, parseInt(job.timeout_s, 10) || 0)) || 300;
  }
  return j;
}

function validateComplete(j) {
  if (!j.name) throw new Error('name required');
  if (!j.type) throw new Error('type required');
  if (!j.cron) throw new Error('schedule required');
  if (j.type === 'prompt' && !j.prompt) throw new Error('prompt jobs need a prompt');
  if (j.type === 'shell' && !j.command && !j.script_path) throw new Error('shell jobs need a command or script_path');
}

function list() { return readAll(); }
function get(id) { return readAll().find((j) => j.id === id) || null; }

function create(input) {
  const j = sanitize(input, {
    id: 'sch_' + crypto.randomBytes(6).toString('hex'),
    enabled: input.enabled !== false,
    type: input.type,
    created_at: Date.now(),
    last_run: null, next_run: null, last_status: null, last_output: null, last_error: null,
  });
  validateComplete(j);
  j.next_run = j.enabled ? nextRun(j.cron) : null;
  const jobs = readAll(); jobs.push(j); writeAll(jobs);
  return j;
}

function update(id, patch) {
  const jobs = readAll(); const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) throw new Error('no such schedule');
  const j = sanitize(patch, jobs[i]);
  validateComplete(j);
  j.updated_at = Date.now();
  // recompute next_run when cadence or enabled changes
  j.next_run = j.enabled ? nextRun(j.cron) : null;
  jobs[i] = j; writeAll(jobs);
  return j;
}

function remove(id) {
  const jobs = readAll(); const next = jobs.filter((j) => j.id !== id);
  if (next.length === jobs.length) return false;
  writeAll(next); return true;
}

/** Jobs that are enabled AND due (next_run <= now). Missed-while-down jobs surface here on the next tick. */
function dueJobs(nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  return readAll().filter((j) => j.enabled && typeof j.next_run === 'number' && j.next_run <= now);
}

/** Record the outcome of a run and roll next_run forward. `status` ∈ ok|error|skipped. */
function markRan(id, { status, output, error, ranAtMs } = {}) {
  const jobs = readAll(); const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) return null;
  const j = jobs[i];
  const at = typeof ranAtMs === 'number' ? ranAtMs : Date.now();
  j.last_run = at;
  j.last_status = status || 'ok';
  j.last_output = output != null ? String(output).slice(0, 8000) : null;
  j.last_error = error != null ? String(error).slice(0, 2000) : null;
  j.next_run = j.enabled ? nextRun(j.cron, at) : null; // advance from run time so a slow run can't re-fire the same minute
  jobs[i] = j; writeAll(jobs);
  return j;
}

/** Human-readable summary of a schedule for lists/logs. */
function describe(spec) {
  try {
    const cron = toCron(spec);
    return cron;
  } catch (_) { return 'invalid'; }
}

module.exports = {
  file, list, get, create, update, remove, dueJobs, markRan,
  toCron, validateCron, parseCron, matches, nextRun, describe,
  normalizePromptSession, promptConversationKey,
};
