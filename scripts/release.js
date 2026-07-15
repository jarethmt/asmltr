#!/usr/bin/env node
'use strict';
/**
 * asmltr release cutter — bump the version, roll the changelog, and tag a pinned release.
 *
 * Steps: compute next semver → write VERSION + sync every package.json version → move the
 * CHANGELOG "[Unreleased]" section under a dated "[X.Y.Z]" heading (+ a fresh empty Unreleased) →
 * git commit "release: vX.Y.Z" → git tag vX.Y.Z. With --push it pushes the commit + tag; with --gh
 * it also creates a GitHub release. The `stable` update channel installs whatever the newest tag is.
 *
 * Usage: node scripts/release.js <major|minor|patch|X.Y.Z> [--notes "..."] [--push] [--gh] [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const VERSION_FILE = path.join(REPO, 'VERSION');
const CHANGELOG = path.join(REPO, 'CHANGELOG.md');
const LOCK_FILE = path.join(REPO, 'package-lock.json');
const PKG_FILES = ['package.json', 'core/package.json', 'connectors/package.json', 'cli/package.json', 'insights/collector/package.json', 'insights/dashboard/package.json'].map((p) => path.join(REPO, p));

const argv = process.argv.slice(2);
const bumpArg = argv.find((a) => !a.startsWith('--'));
const DRY = argv.includes('--dry-run');
const PUSH = argv.includes('--push');
const GH = argv.includes('--gh');
const notes = (() => { const i = argv.indexOf('--notes'); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; })();

function die(m) { console.error('release: ' + m); process.exit(1); }
function git(...a) { const r = spawnSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }); if (r.status !== 0) die(`git ${a[0]} failed: ${(r.stderr || '').trim()}`); return (r.stdout || '').trim(); }

function readVersion() { return fs.readFileSync(VERSION_FILE, 'utf8').trim(); }
function nextVersion(cur, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [maj, min, pat] = cur.split('.').map(Number);
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  if (bump === 'patch') return `${maj}.${min}.${pat + 1}`;
  die(`bad bump '${bump}' — want major|minor|patch|X.Y.Z`);
}

if (!bumpArg) die('usage: release.js <major|minor|patch|X.Y.Z> [--notes ..] [--push] [--gh] [--dry-run]');

// clean tree check (allow gitignored). Refuse to release on top of uncommitted tracked changes.
const dirty = git('status', '--porcelain', '--untracked-files=no');
if (dirty && !DRY) die('working tree has uncommitted tracked changes — commit them first:\n' + dirty);

const cur = readVersion();
const next = nextVersion(cur, bumpArg);
const tag = 'v' + next;
if (git('tag', '-l', tag)) die(`tag ${tag} already exists`);

// changelog: turn "## [Unreleased]" into a dated release section + a fresh empty Unreleased
const date = new Date().toISOString().slice(0, 10);
let cl = fs.readFileSync(CHANGELOG, 'utf8');
const marker = '## [Unreleased]';
if (cl.includes(marker)) {
  const relHead = `## [${next}] - ${date}`;
  const freshUnreleased = `${marker}\n\n### Added\n\n### Changed\n\n### Fixed\n\n${relHead}`;
  cl = cl.replace(marker, freshUnreleased);
  if (notes) cl = cl.replace(relHead, `${relHead}\n\n${notes}`);
} else {
  cl = cl.replace(/^# Changelog\n/, `# Changelog\n\n## [${next}] - ${date}\n${notes ? notes + '\n' : ''}`);
}

const bumpPkg = (p) => { const t = fs.readFileSync(p, 'utf8'); return t.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`); };

// Refresh package-lock.json so the tag ships a lock matching the bumped manifests; `npm ci` on a
// `stable`-channel install depends on it. Resolve-only (--package-lock-only): no node_modules, no
// native build. Best-effort — a missing npm shouldn't sink a release, but a stale lock would.
function refreshLock() {
  const r = spawnSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) { console.error('release: lockfile refresh failed, continuing without it: ' + ((r.stderr || '').trim().split('\n').pop() || '')); return false; }
  return fs.existsSync(LOCK_FILE);
}

const plan = { from: cur, to: next, tag, files: ['VERSION', 'CHANGELOG.md', ...PKG_FILES.map((p) => path.relative(REPO, p)), ...(fs.existsSync(LOCK_FILE) ? ['package-lock.json'] : [])], push: PUSH, gh: GH };

if (DRY) { console.log('DRY RUN release plan:\n' + JSON.stringify(plan, null, 2)); process.exit(0); }

// write
fs.writeFileSync(VERSION_FILE, next + '\n');
fs.writeFileSync(CHANGELOG, cl);
for (const p of PKG_FILES) { try { fs.writeFileSync(p, bumpPkg(p)); } catch (e) { console.error('skip ' + p + ': ' + e.message); } }

const lockRefreshed = refreshLock();
const addFiles = ['VERSION', 'CHANGELOG.md', ...PKG_FILES.map((p) => path.relative(REPO, p))];
if (lockRefreshed) addFiles.push('package-lock.json');
git('add', ...addFiles);
git('commit', '-m', `release: ${tag}`);
git('tag', '-a', tag, '-m', notes ? `${tag}\n\n${notes}` : tag);
console.log(`✅ committed + tagged ${tag} (was v${cur})`);

if (PUSH) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('push', 'origin', `${branch}:main`);
  git('push', 'origin', tag);
  console.log(`pushed ${branch}→main + ${tag}`);
}
if (GH) {
  const r = spawnSync('gh', ['release', 'create', tag, '--title', tag, '--notes', notes || `asmltr ${tag}`], { cwd: REPO, encoding: 'utf8' });
  console.log(r.status === 0 ? `gh release ${tag} created` : `gh release failed: ${(r.stderr || '').trim()}`);
}
console.log(PUSH ? 'Done. `stable`-channel installs will pick this up.' : 'Local only — add --push (and --gh) to publish.');
