# Integrations & storage

**Vocabulary:** a **connector** is an I/O channel the assistant uses to talk to a *human* (Discord,
Telegram, email, …). An **integration** is a link to a *third-party service* (storage today; more
later). They're managed separately — connectors under **Connectors**, integrations under
**Integrations** in the dashboard.

Unlike connectors, integrations aren't supervised processes — they're **config + a driver loaded on
demand**. Their secrets live in the [TRUST vault](../security/trust-vault.md), never in the config.

## The storage substrate

`shared/storage.js` defines one backend-agnostic driver contract that both **data silos** and
**backups** ride on:

```
put(path, data) · get(path) · stat(path) · list(prefix, {recursive})
remove(path) · move(from, to) · mkdir(path) · mint(path, {verb, ttl})
```

`mint()` is the control-plane→data-plane handoff: it returns a short-lived, scoped **capability** (an
S3/WebDAV presigned URL) so a peer transfers bytes *direct* to the backend — the owner never proxies
the bytes.

### Drivers

| Type | Backends | Notes |
|------|----------|-------|
| `local` | local disk | built-in, always available; silos are local-first |
| `webdav` | Nextcloud, ownCloud, any WebDAV | `base_url` + `username` + `password` (a vault key) + `root` |
| `s3` | **AWS S3, Backblaze B2, DigitalOcean Spaces, Cloudflare R2, MinIO** | one driver via `endpoint`/`region`/`bucket` + keys; presigned `mint` |

Object-storage credentials never need a box to run. A **self-hosted** node (a Linux box running WebDAV
or SFTP, optionally provisioned by asmltr from bare SSH) is the alternative — see the
[roadmap](../ROADMAP-VAULT-SILOS-BACKUP.md#integrations--storage-backends).

## The registry

`integrations/registry.js` stores integration configs. **Secret fields are stored as `*_ref` — a vault
key name, not the secret** — and resolved from the vault only when the integration is opened:

```json
{
  "type": "webdav",
  "name": "3DPP Nextcloud",
  "config": {
    "base_url": "https://files.example.com/remote.php/dav/files/user",
    "username": "assistant@example.com",
    "root": "asmltr-silos",
    "password_ref": "nextcloud_password"   // ← vault key name; the secret lives in the vault
  }
}
```

Manage integrations via the dashboard **Integrations** plane (add/configure/**test**/delete) or the API:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v2/integrations` | list (configs only; `*_ref` are key names, never secrets) |
| POST | `/v2/integrations` | create `{ type, name, config }` |
| PATCH | `/v2/integrations/{id}` | update |
| DELETE | `/v2/integrations/{id}` | remove |
| POST | `/v2/integrations/{id}/test` | open + a cheap connectivity check → `{ ok }` |

## Encryption at rest

`EncryptedStorage` is a composable wrapper over **any** driver — AES-256-GCM, so the backend (and anyone
browsing it, e.g. in Nextcloud's web UI) sees only ciphertext. The per-silo data key comes from the
vault's **KMS**: asmltr asks the vault to `generate` a data key (getting the plaintext once + a wrapped
blob it stores next to the data), and `unwrap`s the blob on demand. The KMS **master key never leaves
the vault**; the plaintext data key lives only transiently in the runtime crypto layer — never in the
model's context — and is zeroed after use.

Encryption is chosen **per silo**: `at-rest` (ciphertext, opaque to the backend + humans) vs. `none`
(plaintext, so a human can edit files directly in the storage UI). See the
[roadmap](../ROADMAP-VAULT-SILOS-BACKUP.md#silo-security--access) for the full silo model.
