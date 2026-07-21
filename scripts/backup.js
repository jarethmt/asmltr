'use strict';
/**
 * Backups — a portable, encrypted, restorable snapshot of an asmltr install (roadmap P4;
 * docs/ROADMAP-VAULT-SILOS-BACKUP.md).
 *
 * What's captured:
 *   • the SQLite DBs (core sessions, trust store, insights) via the online-backup API — a *consistent*
 *     snapshot safe against the live, running services (never a torn file copy);
 *   • the `~/.asmltr` home store — identity + facets, integrations.json, the silos (Self + data), context.d;
 *   • the restore-critical repo config (gitignored, secret-bearing): .env, connector configs, trust seed,
 *     the instance compose override, CLAUDE.local.md.
 *
 * The archive is a gzipped tar, encrypted with **AES-256-GCM under a key derived from a passphrase**
 * (scrypt) — deliberately independent of the TRUST vault, so a *vault loss is itself recoverable* from a
 * backup. Layout: [ MAGIC(9) | salt(16) | iv(12) | ciphertext… | authTag(16) ] (tag at the end so both
 * encrypt and decrypt stream, never loading the whole archive into memory).
 *
 * Usable as a module (createBackup/verifyBackup/restoreBackup) or a CLI (`node scripts/backup.js …`).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const HOME = os.homedir();
const ASMLTR = path.join(HOME, '.asmltr');
const BACKUP_DIR = process.env.ASMLTR_BACKUP_DIR || path.join(ASMLTR, 'backups');
const SCHEDULE_FILE = process.env.ASMLTR_BACKUP_SCHEDULE_FILE || path.join(ASMLTR, 'backup-schedule.json');
const REMOTE_PREFIX = 'asmltr-backups'; // subfolder within a destination integration's root
function registry() { return require('../integrations/registry'); } // lazy — pulls in storage drivers only when a remote is used
const MAGIC = Buffer.from('ASMLTRBK1'); // 9 bytes
const HEADER_LEN = MAGIC.length + 16 + 12; // magic + salt + iv = 37
const TAG_LEN = 16;

function readVersion() { try { return require('../shared/version').readVersion(); } catch (_) { return '0.0.0'; } }

// better-sqlite3 is installed in the core / collector workspaces (not repo root) — resolve it from there.
function requireBetterSqlite() {
  for (const base of ['better-sqlite3', path.join(REPO, 'core', 'node_modules', 'better-sqlite3'), path.join(REPO, 'insights', 'collector', 'node_modules', 'better-sqlite3')]) {
    try { return require(base); } catch (_) { /* try next */ }
  }
  throw new Error('better-sqlite3 not found (looked in repo root + core/ + collector/ node_modules)');
}

// Consistent-snapshot sources. Paths mirror the modules that own them (env overrides respected).
const SQLITE_DBS = [
  { key: 'core', path: require('../core/src/db-path').coreDbPath() },
  { key: 'trust', path: process.env.ASMLTR_TRUST_DB || path.join(REPO, 'core', 'data', 'trust.db') },
  { key: 'insights', path: process.env.ASMLTR_INSIGHTS_DB || path.join(REPO, 'insights', 'collector', 'data', 'insights.db') },
];
// Gitignored, secret-bearing repo config — without these a restore can't reconnect. Overridable via
// ASMLTR_BACKUP_CONFIG_FILES (comma-separated repo-relative paths) for bespoke installs / testing.
const CONFIG_FILES = (process.env.ASMLTR_BACKUP_CONFIG_FILES != null
  ? process.env.ASMLTR_BACKUP_CONFIG_FILES.split(',').map((s) => s.trim()).filter(Boolean)
  : [
    '.env', 'CLAUDE.local.md',
    'connectors/types/mcp/clients.json',
    'connectors/types/openai/keys.json',
    'connectors/types/discord/channel-aliases.json',
    'core/src/trust/seed.json',
  ]);
// Also capture any per-instance dashboard compose override (insights/docker-compose.<name>.yml,
// gitignored) so a restore can redeploy the dashboard. Skipped when the file list is env-overridden.
if (process.env.ASMLTR_BACKUP_CONFIG_FILES == null) {
  try { for (const f of fs.readdirSync(path.join(REPO, 'insights')).filter((n) => /^docker-compose\..+\.yml$/.test(n))) CONFIG_FILES.push('insights/' + f); } catch (_) {}
}

// ── crypto ───────────────────────────────────────────────────────────────────
function deriveKey(passphrase, salt) { return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }

function encryptStream(inPath, outPath, passphrase) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = fs.createWriteStream(outPath);
  return new Promise((resolve, reject) => {
    const fail = (e) => { key.fill(0); reject(e); };
    const rs = fs.createReadStream(inPath);
    rs.on('error', fail); cipher.on('error', fail); out.on('error', fail);
    out.write(Buffer.concat([MAGIC, salt, iv]));       // header first
    cipher.on('end', () => { out.write(cipher.getAuthTag()); out.end(); }); // tag last
    out.on('finish', () => { key.fill(0); resolve(); });
    rs.pipe(cipher).pipe(out, { end: false });
  });
}

function decryptStream(inPath, outPath, passphrase) {
  const size = fs.statSync(inPath).size;
  const fd = fs.openSync(inPath, 'r');
  try {
    const header = Buffer.alloc(HEADER_LEN); fs.readSync(fd, header, 0, HEADER_LEN, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an asmltr backup (bad header)');
    const salt = header.subarray(9, 25), iv = header.subarray(25, 37);
    const tag = Buffer.alloc(TAG_LEN); fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
    const key = deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    return new Promise((resolve, reject) => {
      const fail = (e) => { key.fill(0); reject(e.message && /auth/i.test(e.message) ? new Error('decrypt failed — wrong passphrase or corrupt archive') : e); };
      const rs = fs.createReadStream(inPath, { start: HEADER_LEN, end: size - TAG_LEN - 1 });
      const out = fs.createWriteStream(outPath);
      rs.on('error', fail); decipher.on('error', fail); out.on('error', fail);
      out.on('finish', () => { key.fill(0); resolve(); });
      rs.pipe(decipher).pipe(out);
    });
  } finally { fs.closeSync(fd); }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function sha256(file) { const h = crypto.createHash('sha256'); h.update(fs.readFileSync(file)); return h.digest('hex'); }
function tar(args) { const r = spawnSync('tar', args, { encoding: 'utf8' }); if (r.status !== 0) throw new Error('tar failed: ' + (r.stderr || r.status)); return r.stdout; }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function ts() { return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', ''); }

// Integrity — recompute each recorded artifact's SHA-256 against the manifest (accuracy guarantee on
// top of the GCM tag: GCM proves the archive is authentic; this proves create() captured what it claims).
function verifyChecksums(root, manifest, log = () => {}) {
  const sums = manifest.checksums || {};
  const mismatches = [];
  let checked = 0;
  for (const [rel, want] of Object.entries(sums)) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) { mismatches.push({ file: rel, reason: 'missing' }); log('✗ ' + rel + ': missing'); continue; }
    checked++;
    const got = sha256(p);
    if (got !== want) { mismatches.push({ file: rel, reason: 'checksum', want, got }); log('✗ ' + rel + ': checksum mismatch'); }
  }
  return { checked, mismatches };
}

// Bring a freshly-restored install back ONLINE: idempotent setup steps (relink CLI/skill/alias) → restart.
function activate(log = () => {}) {
  try { const { runSetupSteps } = require('./run-setup-steps'); const r = runSetupSteps({ log }); log(`setup: ${r.applied.length} applied, ${r.alreadyDone.length} already done, ${r.failed.length} failed`); }
  catch (e) { log('setup steps error (non-fatal): ' + e.message); }
  const svcs = ['asmltr-core', 'asmltr-connector-manager', 'asmltr-insights-collector'];
  const r = spawnSync('pm2', ['restart', ...svcs], { encoding: 'utf8' });
  if (r.status === 0) log('restarted: ' + svcs.join(' '));
  else log('pm2 restart skipped/failed: ' + (r.stderr || (r.error && r.error.message) || r.status));
  return r.status === 0;
}

// Poll the core's /version until it answers — confirms the restored install is actually serving.
async function healthCheck(log = () => {}, base = process.env.ASMLTR_CORE_BASE || 'http://127.0.0.1:3023') {
  for (let i = 0; i < 12; i++) {
    try { const r = await fetch(base + '/version'); if (r.ok) { const v = await r.json(); log(`online: ${v.service} ${v.version} (${v.channel})`); return true; } } catch (_) {}
    await new Promise((res) => setTimeout(res, 1500));
  }
  log('health check: core did not report /version in time');
  return false;
}

function resolvePassphrase(opts = {}) {
  const p = opts.passphrase || process.env.ASMLTR_BACKUP_PASSPHRASE || process.env.TRUST_PROTOCOL_VAULT_PASSWORD;
  if (!p) throw new Error('no backup passphrase — set ASMLTR_BACKUP_PASSPHRASE (or pass --passphrase). Off-box backups should use a dedicated passphrase.');
  return String(p);
}

// ── create ───────────────────────────────────────────────────────────────────
async function createBackup(opts = {}) {
  const passphrase = resolvePassphrase(opts);
  const label = (opts.label || 'manual').replace(/[^a-z0-9_-]/gi, '');
  ensureDir(BACKUP_DIR);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-bk-'));
  const log = opts.log || (() => {});
  try {
    const manifest = { format: 1, tool: 'asmltr backup', version: readVersion(), label, created_at: Date.now(), host: os.hostname(), components: {}, checksums: {} };

    // 1) SQLite — consistent online-backup snapshots. better-sqlite3 lives in a workspace, not repo root.
    ensureDir(path.join(stage, 'db'));
    const Database = requireBetterSqlite();
    for (const d of SQLITE_DBS) {
      if (!fs.existsSync(d.path)) { manifest.components['db/' + d.key] = { present: false }; continue; }
      const dest = path.join(stage, 'db', d.key + '.db');
      const db = new Database(d.path, { readonly: true });
      try { await db.backup(dest); } finally { db.close(); }
      manifest.components['db/' + d.key] = { present: true, bytes: fs.statSync(dest).size };
      manifest.checksums['db/' + d.key + '.db'] = sha256(dest);
      log(`db: ${d.key} (${manifest.components['db/' + d.key].bytes} bytes)`);
    }

    // 2) repo config (gitignored, secret-bearing)
    for (const rel of CONFIG_FILES) {
      const src = path.join(REPO, rel);
      if (!fs.existsSync(src)) { manifest.components['repo/' + rel] = { present: false }; continue; }
      const dest = path.join(stage, 'repo', rel); ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
      manifest.components['repo/' + rel] = { present: true };
      manifest.checksums['repo/' + rel] = sha256(dest);
    }

    // 3) ~/.asmltr home store (identity, integrations, silos, context.d) — minus backups/ (no recursion)
    if (fs.existsSync(ASMLTR)) {
      const dest = path.join(stage, 'home');
      fs.cpSync(ASMLTR, dest, { recursive: true, filter: (s) => s !== BACKUP_DIR && !s.startsWith(BACKUP_DIR + path.sep) });
      let files = 0, bytes = 0;
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } };
      walk(dest);
      manifest.components['home'] = { present: true, files, bytes };
      log(`home: ${files} files (${bytes} bytes)`);
    } else { manifest.components['home'] = { present: false }; }

    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // 4) tar → encrypt
    const tarPath = path.join(stage, '..', path.basename(stage) + '.tgz');
    tar(['-czf', tarPath, '-C', stage, '.']);
    const outName = `asmltr-${manifest.version}-${label}-${ts()}.asmltrbk`;
    const outPath = opts.out || path.join(BACKUP_DIR, outName);
    await encryptStream(tarPath, outPath, passphrase);
    fs.rmSync(tarPath, { force: true });
    const bytes = fs.statSync(outPath).size;
    log(`wrote ${outPath} (${bytes} bytes)`);

    // Optional off-box copy: push the (already-encrypted) archive to a configured storage integration.
    let remote = null;
    if (opts.destination && opts.destination !== 'local') {
      const store = await registry().openStorage(opts.destination);
      const remotePath = `${REMOTE_PREFIX}/${path.basename(outPath)}`;
      await store.put(remotePath, fs.readFileSync(outPath));
      remote = { integration: opts.destination, path: remotePath };
      log(`pushed to integration ${opts.destination}:${remotePath}`);
    }
    return { file: outPath, manifest, bytes, remote };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

// ── verify (decrypt + tar integrity + per-file checksums, no restore) ─────────
async function verifyBackup(file, opts = {}) {
  const passphrase = resolvePassphrase(opts);
  const log = opts.log || (() => {});
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-vrfy-'));
  const tarPath = path.join(tmp, 'archive.tgz');
  const extract = path.join(tmp, 'x');
  try {
    await decryptStream(file, tarPath, passphrase);   // GCM auth — archive is authentic + right passphrase
    tar(['-tzf', tarPath]);                           // gzip + tar structural integrity
    ensureDir(extract);
    tar(['-xzf', tarPath, '-C', extract]);
    const manifest = JSON.parse(fs.readFileSync(path.join(extract, 'manifest.json'), 'utf8'));
    const { checked, mismatches } = verifyChecksums(extract, manifest, log);
    return { ok: mismatches.length === 0, file, bytes: fs.statSync(file).size, manifest, checked, mismatches };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ── restore ──────────────────────────────────────────────────────────────────
async function restoreBackup(file, opts = {}) {
  const passphrase = resolvePassphrase(opts);
  const dryRun = !!opts.dryRun;
  const log = opts.log || (() => {});
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-rst-'));
  const tarPath = path.join(tmp, 'archive.tgz');
  const extract = path.join(tmp, 'x');
  try {
    await decryptStream(file, tarPath, passphrase);
    ensureDir(extract);
    tar(['-xzf', tarPath, '-C', extract]);
    const manifest = JSON.parse(fs.readFileSync(path.join(extract, 'manifest.json'), 'utf8'));

    // Accuracy gate: every recorded artifact must match its manifest checksum before we place anything.
    const integrity = verifyChecksums(extract, manifest, log);
    if (integrity.mismatches.length && !opts.force) throw new Error(`integrity check failed — ${integrity.mismatches.length} file(s) mismatched/missing (${integrity.mismatches.map((m) => m.file).join(', ')}); pass force to override`);
    if (integrity.checked) log(`integrity: ${integrity.checked} artifact(s) verified`);

    const plan = [];

    for (const d of SQLITE_DBS) {
      const src = path.join(extract, 'db', d.key + '.db');
      if (fs.existsSync(src)) plan.push({ from: src, to: d.path });
    }
    for (const rel of CONFIG_FILES) {
      const src = path.join(extract, 'repo', rel);
      if (fs.existsSync(src)) plan.push({ from: src, to: path.join(REPO, rel) });
    }
    const homeSrc = path.join(extract, 'home');
    const homeDir = fs.existsSync(homeSrc);

    if (dryRun) {
      log(`[dry-run] backup ${manifest.version}/${manifest.label} @ ${new Date(manifest.created_at).toISOString()}`);
      for (const p of plan) log(`[dry-run] would restore ${p.to}`);
      if (homeDir) log(`[dry-run] would merge ~/.asmltr from home/ (${manifest.components.home && manifest.components.home.files} files)`);
      return { ok: true, dryRun: true, manifest, plan: plan.map((p) => p.to) };
    }

    // Safety: stash whatever we're about to overwrite under a timestamped sidecar.
    const stash = path.join(BACKUP_DIR, 'pre-restore-' + ts()); ensureDir(stash);
    for (const p of plan) {
      if (fs.existsSync(p.to)) { const b = path.join(stash, path.relative(HOME, p.to).replace(/[\\/]/g, '_')); ensureDir(path.dirname(b)); fs.copyFileSync(p.to, b); }
      ensureDir(path.dirname(p.to));
      fs.copyFileSync(p.from, p.to);
      log(`restored ${p.to}`);
    }
    if (homeDir) { fs.cpSync(homeSrc, ASMLTR, { recursive: true }); log(`merged ~/.asmltr (${manifest.components.home && manifest.components.home.files} files)`); }

    // Bring the install back online (setup.d → restart → health-check), or tell the operator how.
    let online = null;
    if (opts.activate) { activate(log); online = await healthCheck(log); }
    else log('restore complete — activate with `asmltr backup restore <file> --activate`, or: pm2 restart asmltr-core asmltr-connector-manager asmltr-insights-collector');
    log(`prior files stashed under ${stash}`);
    return { ok: true, manifest, restored: plan.map((p) => p.to), stash, online, integrity };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ── list ─────────────────────────────────────────────────────────────────────
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.asmltrbk')).map((f) => {
    const p = path.join(BACKUP_DIR, f); const st = fs.statSync(p);
    return { file: p, name: f, bytes: st.size, mtime: st.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
}

// ── remote listing + retention ────────────────────────────────────────────────
async function listRemoteBackups(destination) {
  const store = await registry().openStorage(destination);
  const entries = await store.list(REMOTE_PREFIX, { recursive: false }).catch(() => []);
  return entries.filter((e) => e.type === 'file' && e.path.endsWith('.asmltrbk'))
    .map((e) => ({ name: path.basename(e.path), path: e.path, bytes: e.size, mtime: e.mtime }))
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}

/** Enforce retention (keep newest `maxCount`, drop older than `maxAgeDays`) on local or a remote destination. */
async function pruneBackups({ maxCount = 0, maxAgeDays = 0, destination = 'local', log = () => {} } = {}) {
  const ageCut = maxAgeDays ? Date.now() - maxAgeDays * 86400000 : 0;
  const remote = destination && destination !== 'local';
  const items = remote
    ? await listRemoteBackups(destination)
    : listBackups().map((b) => ({ name: b.name, path: b.file, mtime: b.mtime }));
  const del = remote
    ? async (p) => { const s = await registry().openStorage(destination); await s.remove(p); }
    : async (p) => fs.rmSync(p, { force: true });
  const doomed = items.filter((b, i) => (maxCount && i >= maxCount) || (ageCut && (b.mtime || 0) < ageCut));
  for (const b of doomed) { await del(b.path); log('pruned ' + b.name); }
  return { pruned: doomed.map((b) => b.name), kept: items.length - doomed.length };
}

// ── schedule config + scheduler ────────────────────────────────────────────────
const SCHEDULE_DEFAULT = { enabled: false, every_hours: 24, destination: 'local', max_count: 14, max_age_days: 0, last_run: 0 };
function getSchedule() { try { return { ...SCHEDULE_DEFAULT, ...JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')) }; } catch (_) { return { ...SCHEDULE_DEFAULT }; } }
function setSchedule(patch) { const s = { ...getSchedule(), ...patch }; ensureDir(path.dirname(SCHEDULE_FILE)); fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(s, null, 2)); return s; }

/** Run one scheduled backup + retention pass per the persisted schedule config. */
async function runScheduled(opts = {}) {
  const s = getSchedule();
  const r = await createBackup({ label: 'scheduled', destination: s.destination, log: opts.log });
  const local = await pruneBackups({ maxCount: s.max_count, maxAgeDays: s.max_age_days, destination: 'local', log: opts.log });
  let remotePrune = null;
  if (s.destination && s.destination !== 'local') remotePrune = await pruneBackups({ maxCount: s.max_count, maxAgeDays: s.max_age_days, destination: s.destination, log: opts.log }).catch((e) => ({ error: e.message }));
  setSchedule({ last_run: Date.now() });
  return { backup: r.file, remote: r.remote, pruned: local.pruned, remotePruned: remotePrune && remotePrune.pruned };
}

/** Start an in-process timer that fires runScheduled() when the interval elapses. Returns the timer. */
function startScheduler({ log = () => {}, intervalMs = 10 * 60 * 1000 } = {}) {
  const tick = async () => {
    try {
      const s = getSchedule();
      if (!s.enabled) return;
      if (Date.now() - (s.last_run || 0) < (s.every_hours || 24) * 3600000) return;
      if (!(process.env.ASMLTR_BACKUP_PASSPHRASE || process.env.TRUST_PROTOCOL_VAULT_PASSWORD)) return void log('scheduled backup due but skipped — no passphrase (set ASMLTR_BACKUP_PASSPHRASE)');
      log('running scheduled backup…');
      const r = await runScheduled({ log });
      log(`scheduled backup done: ${r.backup}${r.pruned.length ? ` (pruned ${r.pruned.length})` : ''}`);
    } catch (e) { log('scheduled backup error: ' + e.message); }
  };
  const t = setInterval(tick, intervalMs); if (t.unref) t.unref();
  const boot = setTimeout(tick, 15000); if (boot.unref) boot.unref(); // first check shortly after boot
  return t;
}

module.exports = { createBackup, verifyBackup, restoreBackup, verifyChecksums, activate, healthCheck, listBackups, listRemoteBackups, pruneBackups, getSchedule, setSchedule, runScheduled, startScheduler, BACKUP_DIR };

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  const flags = {}; const pos = [];
  for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) { const k = rest[i].slice(2); if (rest[i + 1] && !rest[i + 1].startsWith('--')) { flags[k] = rest[++i]; } else flags[k] = true; } else pos.push(rest[i]); }
  const log = (m) => console.log(m);
  (async () => {
    try {
      if (cmd === 'create') { const r = await createBackup({ label: flags.label, passphrase: flags.passphrase, out: flags.out, log }); console.log(JSON.stringify({ file: r.file, bytes: r.bytes }, null, 2)); }
      else if (cmd === 'list') { for (const b of listBackups()) console.log(`${b.name}\t${(b.bytes / 1048576).toFixed(2)} MB`); }
      else if (cmd === 'verify') { const r = await verifyBackup(pos[0], { passphrase: flags.passphrase, log }); console.log(r.ok ? `OK — ${r.manifest.version}/${r.manifest.label} @ ${new Date(r.manifest.created_at).toISOString()} (${r.checked} artifacts verified)` : `INTEGRITY FAILED — ${r.mismatches.map((m) => m.file).join(', ')}`); if (!r.ok) process.exit(1); }
      else if (cmd === 'restore') { await restoreBackup(pos[0], { passphrase: flags.passphrase, dryRun: flags['dry-run'], activate: flags.activate, force: flags.force, log }); }
      else { console.log('usage: node scripts/backup.js <create|list|verify|restore> [file] [--label x] [--passphrase x] [--dry-run] [--out path]'); process.exit(cmd ? 1 : 0); }
    } catch (e) { console.error('backup error: ' + e.message); process.exit(1); }
  })();
}
