'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// backup.js resolves the staging path once, at load, so both must be set BEFORE the require. Staging
// is placed inside the fixture home store on purpose: that is the default layout (~/.asmltr/uploads-partial),
// and it is the layout where the filter is the only thing keeping partials out of the archive.
const HOME_FIXTURE = path.join(os.tmpdir(), `asmltr-backup-home-${process.pid}`);
const STAGING = path.join(HOME_FIXTURE, 'uploads-partial');
process.env.ASMLTR_UPLOAD_STAGING_DIR = STAGING;
const backup = require('../scripts/backup');

test.after(() => { try { fs.rmSync(HOME_FIXTURE, { recursive: true, force: true }); } catch (_) {} });

test('in-flight upload staging is excluded from the home snapshot', () => {
  assert.equal(backup.UPLOAD_STAGING, STAGING, 'backup must read the staging path from the uploads module');
  assert.ok(backup.excludedFromHome(STAGING), 'the staging root itself');
  assert.ok(backup.excludedFromHome(path.join(STAGING, 'abc-123456', '0.part')), 'a chunk inside it');
});

test('the backups directory is still excluded (no recursion)', () => {
  assert.ok(backup.excludedFromHome(backup.BACKUP_DIR));
  assert.ok(backup.excludedFromHome(path.join(backup.BACKUP_DIR, 'x.asmltrbk')));
});

test('a finished upload in the Self silo is still backed up', () => {
  // Only partials are transient. An upload that reached the manifest is an artifact and belongs in the
  // archive — excluding the whole uploads tree would quietly stop backing up the user's files.
  const artifact = path.join(os.homedir(), '.asmltr', 'silos', 'self', 'uploads', 'discord', 'photo.jpg');
  assert.equal(backup.excludedFromHome(artifact), false);
});

test('a snapshot taken mid-upload copies the artifacts and leaves the partial behind', () => {
  // The predicate is one thing; the copy honoring it is the guarantee. Build a home store with a live
  // partial staged in it and run the same filter createBackup() passes to fs.cpSync.
  const dest = path.join(os.tmpdir(), `asmltr-backup-dest-${process.pid}`);
  fs.rmSync(HOME_FIXTURE, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME_FIXTURE, 'silos', 'self', 'uploads', 'discord'), { recursive: true });
  fs.writeFileSync(path.join(HOME_FIXTURE, 'silos', 'self', 'uploads', 'discord', 'kept.bin'), 'artifact');
  fs.mkdirSync(path.join(STAGING, 'abc-123456'), { recursive: true });
  fs.writeFileSync(path.join(STAGING, 'abc-123456', '0.part'), 'x'.repeat(4096));

  try {
    fs.cpSync(HOME_FIXTURE, dest, { recursive: true, filter: (s) => !backup.excludedFromHome(s) });
    assert.equal(fs.readFileSync(path.join(dest, 'silos', 'self', 'uploads', 'discord', 'kept.bin'), 'utf8'), 'artifact');
    const seen = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); seen.push(p); if (e.isDirectory()) walk(p); } };
    walk(dest);
    assert.equal(seen.some((p) => /\.part$/.test(p)), false, `no staged chunk may reach a backup: ${seen.join(', ')}`);
    assert.equal(fs.existsSync(path.join(dest, 'uploads-partial')), false, 'the staging directory itself must not be copied');
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});
