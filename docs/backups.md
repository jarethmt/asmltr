# Backups

A backup is a **portable, encrypted, restorable snapshot** of an asmltr install. One is taken
automatically before every self-update; you can also take, restore, and import them on demand — from
the CLI **or** the dashboard.

## What's captured

| Component | Source | How |
|-----------|--------|-----|
| **SQLite DBs** | core sessions, trust store, insights | the SQLite **online-backup API** — a *consistent* snapshot, safe against the live running services (never a torn file copy) |
| **Home store** | `~/.asmltr` | identity + facets, `integrations.json`, the **silos** (Self + data), `context.d` |
| **Repo config** | gitignored, secret-bearing | `.env`, connector configs, trust `seed.json`, the instance compose override, `CLAUDE.local.md` |

A `manifest.json` (version, label, timestamp, component list, per-artifact SHA-256) rides inside the archive.

## Encryption — vault-independent by design

The archive is a gzipped tar encrypted with **AES-256-GCM under a key derived from a passphrase**
(`scrypt`). This is deliberately **independent of the [TRUST vault](security/trust-vault.md)**: if you
encrypted backups with a vault key, you couldn't restore after *losing the vault* — the exact disaster
backups exist for. So a vault loss is itself recoverable from a backup.

File layout (tag at the end, so both encrypt and decrypt stream without loading the whole archive):

```
[ MAGIC(9) | salt(16) | iv(12) | ciphertext… | authTag(16) ]
```

### The passphrase

Resolution order: `--passphrase` → `ASMLTR_BACKUP_PASSPHRASE` → `TRUST_PROTOCOL_VAULT_PASSWORD`. On a
single box the vault password is a convenient default; **off-box backups should use a dedicated
passphrase**. There's no recovery if the passphrase is lost — GCM authentication rejects a wrong one.

## CLI

```bash
asmltr backup create [--label nightly] [--passphrase …]   # write a snapshot to ~/.asmltr/backups
asmltr backup list                                        # newest first
asmltr backup verify <file>                               # decrypt + tar integrity + per-file checksums
asmltr backup restore <file> [--dry-run] [--activate]     # --dry-run prints the plan and changes nothing
```

**Integrity is verified two ways.** The GCM auth tag proves the archive is authentic and the passphrase
is right; then every recorded artifact's **SHA-256 is recomputed against the manifest**. `verify` reports
`N artifacts verified`; `restore` runs the same check **before it places anything** and aborts on a
mismatch (override with `--force`).

Restore places each artifact back — **stashing any file it overwrites** under
`~/.asmltr/backups/pre-restore-<ts>/` first — then leaves the install stopped unless you activate it.

### Bring the install online (`--activate`)

`--activate` finishes the import: it runs the idempotent [`setup.d`](reference/config.md) steps (relink
the CLI / skill / alias — important on a *fresh* box), restarts the host services, and **polls
`/version` until the core is serving**:

```bash
asmltr backup restore <file> --activate
```

Without `--activate`, restore prints the manual step instead:
`pm2 restart asmltr-core asmltr-connector-manager asmltr-insights-collector`.

## Set up from a backup (import to a fresh box)

To reconstitute an install elsewhere:

1. Install asmltr (clone + `npm ci`) and put the backup passphrase in the environment
   (`ASMLTR_BACKUP_PASSPHRASE`), plus the vault access keys if you use one.
2. Copy the `.asmltrbk` archive over (or pull it from the remote destination it was pushed to).
3. `asmltr backup verify <file>` — confirm integrity first.
4. `asmltr backup restore <file> --activate` — reconstitutes the DBs, config, identity, and silos,
   runs setup, and brings the services online.

The restore is byte-accurate (checksum-gated) and idempotent; the pre-restore stash lets you roll back.

## Remote destinations

A backup can be pushed **off-box** to any configured [storage integration](integrations/index.md)
(WebDAV, S3-compatible, or a local path) — the encrypted archive is uploaded under an
`asmltr-backups/` prefix in the integration's root. Pass a destination by integration id:

```bash
asmltr backup create --label offsite --destination int_ab12cd34   # or pick it in the dashboard
```

The archive is already encrypted, so it's safe on third-party storage. `verify`/`restore` still operate
on a **local** file — pull the archive down first if it only lives remotely. Retention (below) prunes the
remote destination too.

## Scheduled backups & retention

**Settings → Backups → Scheduled backups** runs automatic snapshots on a timer, with retention:

| Setting | Meaning |
|---------|---------|
| **Every (hours)** | how often a snapshot is taken |
| **Destination** | local, or a storage integration (off-box) |
| **Max stored** | keep only the newest N (`0` = unlimited) |
| **Max age (days)** | drop anything older than this (`0` = no age limit) |

The scheduler runs **in-process in the core** (checked every ~10 min; persisted in
`~/.asmltr/backup-schedule.json`). It needs a passphrase available to the core process
(`ASMLTR_BACKUP_PASSPHRASE`, or the vault password) — without one, a due backup is logged and skipped
rather than failing. Retention runs after each scheduled snapshot, on both local and the remote destination.

## Dashboard — create, import & restore

**Settings → Backups** lists existing snapshots, creates new ones (with a destination + optional one-off
passphrase), configures the schedule, and now handles **import** and a **guarded restore**.

### Import a backup file

**Import…** uploads a `.asmltrbk` archive from your browser straight into the backup directory (a raw
stream, so it isn't capped by the JSON body limit). Once imported it appears in the list and can be
previewed and restored like any local snapshot — handy for moving a backup onto a fresh box through the
dashboard instead of `scp`.

### Guarded restore

Restore is destructive — it overwrites live config, secrets, and databases and restarts the core — so
instead of hiding it behind the CLI, the dashboard makes it **hard to do by accident**:

1. Click **Restore…** on a snapshot and (optionally) enter its passphrase.
2. **Preview** runs a dry-run: it decrypts, verifies every checksum against the manifest, and lists the
   exact paths that *would* be restored. Nothing is written.
3. To proceed you must **type the backup's name** to confirm.
4. **Restore & restart** hands off to a **detached runner** (so it survives the core restart that
   `--activate` triggers) and streams a live progress log back into the panel.

Under the hood this is the same checksum-gated, pre-restore-stashed [CLI restore](#the-passphrase)
described above — just driven from the browser with a preview + type-to-confirm gate. The passphrase is
passed to the runner through the environment, never on a command line.

## Auto-snapshot before self-update

`scripts/update.js` takes a `pre-update` snapshot before it checks out new code — a *data-level* safety
net on top of the git rollback point. It's best-effort: skipped when no passphrase is configured or when
`ASMLTR_BACKUP_ON_UPDATE=off`, and a snapshot failure never blocks the update (the git rollback still
applies). Config: `ASMLTR_BACKUP_DIR` (default `~/.asmltr/backups`), `ASMLTR_BACKUP_PASSPHRASE`.

## See also

- [Data silos & the Self silo](silos.md) — the memory + artifacts a backup captures.
- [TRUST vault](security/trust-vault.md) — the credential store a backup lets you recover *around*.
