# Roadmap: Vault · Auth · Self Silo · Data Silos · Backups

> Status (v0.5.0): **P0–P4 substantially shipped** — the [TRUST vault](security/trust-vault.md) is live
> (credential broker + KMS), the [storage substrate + integrations](integrations/index.md) (local /
> WebDAV / S3) + EncryptedStorage are built, asmltr is fully de-BWS'd, the dashboard has Vault +
> Integrations + Silos planes, the **[Self silo](silos.md)** (P3) is live (the `.silo/` construct,
> templates, layered search, the `asmltr silo` CLI + explorer, and the SELF-SILO awareness injection),
> and **[backups](backups.md)** (P4) are live — consistent, passphrase-encrypted, vault-independent
> snapshots with restore/verify + an auto-snapshot before every self-update. The guided
> **[`asmltr vault init`](security/trust-vault.md)** bootstrap + passphrase-unseal UX (P2) are also live.
> **Still ahead:** the auth layer (P1), federation guards (P5), and dreaming/consolidation (P6). Progress is tracked in the GitHub epic
> (see bottom). This plan turns asmltr into an identity/core platform whose credentials, memory, and
> artifacts are portable and restorable — with the [TRUST Protocol](https://github.com/jarethmt/trust-protocol)
> as a hard dependency (its first real-world home).

## The one-line vision

An agent's identity persists through **memory + runtime**. The **Self silo** is the portable soul —
identity, relationships, full conversation history, internal state, and *every artifact the agent
creates* — sealed by an operator passphrase, restorable onto a fresh install, and reachable (trust-
gated) by peer agents. Credentials live in the **TRUST vault**, never in the repo, never in BWS.

## Six constructs, one substrate

```
  AUTH LAYER  ──unlocks──▶  TRUST VAULT (hard dep)  ──secrets──▶  asmltr core
  (local + OIDC)                │                                    │
       │                        │ credentials view (names, not values)│
       ▼                        ▼                                    ▼
  ┌──────────────────────  DATA SILOS  ────────────────────────────────┐
  │  Self silo (one) ── default home for artifacts + identity +        │
  │     relationships + FULL transcripts + internal state              │
  │  Project silos (many) ── tagged, provisionable, trust-gated API     │
  └───────────────┬────────────────────────────────────────────────────┘
                  ▼
            BACKUPS ── encrypted snapshots (passphrase) ──▶  STORAGE BACKENDS
                                                             (local · S3/R2 · Nextcloud/WebDAV · SFTP)
```

- **Storage backends** — the shared transport (`shared/storage.js`: `put/list/get/delete`). Used by
  *both* silos and backups. A silo is backend-agnostic and migratable.
- **Data silos** — schema + trust-verified API + backend ref + index. The Self silo (one, special) and
  project silos (many). An agent may expose its own silo for a peer to connect to → the bridge to
  federation (same construct, TRUST-tier gated, instantly revocable).
- **Backups** — encrypted point-in-time snapshots of silos + config + the re-sealed vault.
- **Credentials** — the TRUST vault (AES-256-GCM, use-but-never-see proxy, audit chain). asmltr
  *hard-depends* on it.
- **Auth layer** — built-in operator login (local + OIDC) so operators don't have to bring their own.

## Locked decisions

| Decision | Choice |
|---|---|
| Root key | **Passphrase** (Argon2id-derived) |
| Conversation history | **Keep all, forever** (append-only); compaction is a *derived* layer |
| Vault dependency | **Hard** — home for asmltr's keys *and* any credential the agent stores; GUI vault view |
| Auth 2FA | **TOTP + passkey (WebAuthn)** both |
| Vault-locked boot | **Degraded but loud** — asmltr boots read-only/observability with a prominent "vault locked" banner; secret-needing connectors wait until unlock |
| Self-silo storage | **Local on disk**; backups pushed off-box *if* a remote backend is configured |

## The security model (auth ↔ vault, without a brute-force oracle)

Three secrets, **separated**, so a web portal never becomes an attack surface on the encryption key:

1. **Web login credential** ≠ vault passphrase. Local account (Argon2id password + TOTP + WebAuthn
   passkey) *or* OIDC. Rate-limited + lockout. Issues only a session cookie.
2. **Vault passphrase** → Argon2id → vault master key. Vault is **locked at rest**; the raw passphrase
   is never a web-submittable auth secret.
3. **Linkage (login unlocks vault), safely:** store the vault key **envelope-wrapped under a key
   derived from the login** — `E(vault_key, K_login)`. A successful, throttled, 2FA-gated login
   unwraps it into server memory for the session. A brute-forcer hits the *rate-limited 2FA login*,
   never the crypto; winning the login only releases a blob useless without the login secret.
4. **Paranoid mode (opt-in):** unlinked — require the passphrase entered separately, never wrapped, so
   even a full GUI compromise can't unlock the vault without a human typing it.

The backup root key derives from the vault passphrase (KEK/DEK): the encrypted archive contains the
re-sealed vault + silos + config; restore = "provide the passphrase." These same auth/keying
primitives are the seed of **cast identity proof** later (Ed25519 challenge/response between peers).

## Data silos — structure & interface

### The filesystem is the truth; the manifest is the marker

A silo holds **any data type** (docs, spreadsheets, audio, video, images, code). There is **no
hand-maintained index** — the folder tree *is* the schema, self-describing, and discovery is search
over the real files. Any index is a **derived, rebuildable search accelerator**, never a source of
truth. This removes the "agent forgets to register" failure mode entirely: a file on disk *is* its
registration.

A directory is a silo **iff** it carries a valid `.silo/` marker — the same way `.git/` makes a repo:

```
my-silo/
  README.md                 # human-facing, AUTO-GENERATED from the manifest + template
  .silo/
    manifest.json           # the REQUIRED marker + metadata (signed — see security below)
    index/                  # derived search accelerator (rebuildable; never source of truth)
    cache/
  …content, arranged however the owner/agent likes…
```

The `.silo/` directory (vs. a loose file) keeps the root clean for humans browsing in Finder/Nextcloud
and gives the derived index + cache a tidy home that travels with the silo. The manifest does four
jobs at once: **discovery** (scan a backend for it), **versioning** (`created_with` / `min_asmltr`
compat gate + schema migration on open), **type** (the template it was born from), and **trust
handshake** (owner identity + signed baseline — see security).

```json
// .silo/manifest.json  (authoritative fields are owner-signed)
{
  "id": "self",                       // uuid for project silos
  "name": "Assistant — Self",
  "type": "self",                     // the template it was created from
  "manifest_version": 1,
  "created_with": "0.5.0",
  "min_asmltr": "0.5.0",              // refuse/warn if current asmltr is older
  "created_at": "…", "updated_at": "…",
  "owner_pubkey": "ed25519:…",        // the ONLY authority over this silo
  "storage": { "backend": "local" },
  "trust": { "baseline": "SACRED" },  // signed BASELINE class only — NOT a per-peer ACL
  "search": { "content": "ripgrep" },
  "signature": "ed25519:…"            // owner's signature over the authoritative fields
}
```

### No default zones — templates instead

A fresh `asmltr silo new` gives **only** a manifest + an auto-generated README, and nothing else —
empty and free-form. Structure (zones) is opt-in via a **template**, a versioned scaffold applied at
creation (folders + a README template + optional default search config):

- Built-ins: **`self`** (seeds `memory/{identity,transcripts,dreams}`), `software-project`, `research`,
  `media`, `generic` (README only). User templates live in `~/.asmltr/silo-templates/`;
  `asmltr silo new --template research`.
- After creation, even a templated silo is free-form — the template just seeds a running start.
- **The Self silo is created from the `self` template**, so it *has* structure because a template
  seeded it, not because zones are a global default.

The README is regenerated from the manifest + template so it never drifts and the silo is
self-documenting on disk even to a tool-less human.

### Interface — a file manager you talk to, with search for recall

Two layers, both defined over `shared/storage.js` so they work identically on local disk, Nextcloud,
or S3 (that's what makes silos migratable):

- **Navigation / file-manager verbs:** `overview` (cheap self-describing map for orientation), `ls`,
  `tree`, `stat`, `mkdir`, `rm`, `mv`, `put`, `get`.
- **Search (layered, start cheap):**
  - **L0 — metadata** (filename, mod-date, size, type) — instant, works on *every* data type.
  - **L1 — content keyword** — `ripgrep` on local (zero-index MVP); a synced index for remote backends.
  - **L2 — semantic** (embeddings) — later; where P6 "dreaming" + media captioning/transcription plug in.

```
asmltr silo overview | ls [path] | tree [path] [--depth N]
asmltr silo find <query> [--in path] [--type ext] [--since date] [--content]
asmltr silo get <path> | put <path> [--to zone] | stat|mkdir|rm|mv …
```

**One interface, three consumers:** the owning agent (via the prompt-injected toolbelt), a peer agent
(the trust-gated remote API — same verbs, scoped by grant), and the human (a GUI file-browser over
the same endpoints). "Recovered by another agent" = `find` → `get` over a grant.

## Silo security & access

**Principle: data-at-rest enforces nothing — a guard does.** No file protects itself; anyone with raw
byte access can read/rewrite it. So the manifest is a **signed claim, never the authority**, and all
*remote* access is mediated by a guard (reference monitor). Raw local byte access = "you own the box"
— handled by encryption-at-rest, not the trust model.

Five layers:

1. **Encrypt at rest (KMS envelope)** — each silo has a data key; the runtime uses it to AES-256-GCM
   the content, so raw backend access yields ciphertext. The data key is **wrapped by the TRUST vault's
   KMS** (`generate`/`wrap`/`unwrap`) and stored as a blob in the silo's `.silo/dek` — the KMS **master
   key never leaves the vault**. asmltr holds only the wrapped blob at rest + the plaintext data key
   *transiently, in the runtime crypto layer* (`EncryptedStorage`), **never in the model's context**,
   zeroed after use (`dispose()`). This is distinct from the credential proxy (use-but-never-see, for
   API keys the agent never touches) — the two are complementary vault roles. *(Live: `shared/vault.js`
   + trust-protocol `core/kms.py`.)*
2. **Owner-signed manifest (Ed25519, key in the vault)** — tamper-evident. Editing the policy in
   plaintext breaks the signature → the silo is flagged tampered. Only the owner can re-sign → **only
   the owner can modify the manifest.** (OS file perms on `.silo/` are local belt-and-suspenders; the
   signature is the authority that survives migration.)
3. **Per-peer grants live in the owner's trust ledger, NEVER in the silo.** The manifest carries only
   owner pubkey + a signed *baseline* class. Who-can-do-what (scope, expiry, revocation) lives in the
   owner's local trust store on the owner's hardware and never travels. So editing the manifest grants
   nothing — there's no ACL there to edit.
4. **A guard mediates all remote access**, authorizing against the owner's *live* store:
   ```
   Peer (ANY hardware) ─connect→ owner's guard: verify signed TRUST identity → check grant in owner's
   local store → authorized? mint a short-TTL scoped capability → log to the tamper-evident audit chain
   ```
   Cross-hardware is a non-issue: the requester comes to the owner's guard; authorization always
   evaluates against the owner's own store. The requester just presents a signed identity.
5. **Owner-offline → short-TTL signed capabilities** a guard can verify against the owner pubkey
   *offline*; revocation via the TRUST ledger's revocation list + file-based kill switches (short TTLs
   keep the revocation window small).

### Encryption is per-silo — a policy, not a global (opacity vs. direct editability)

Encryption-at-rest is a **composable layer over `shared/storage.js`** (an `EncryptedStorage` wrapper —
`put` encrypts, `get` decrypts, key per-silo from the vault) so it works over *any* backend. The
`encryption` field in the signed manifest is a **per-silo choice**, trading two things:

- **`at-rest`** — asmltr seals content before upload; the backend and anyone browsing it (e.g. in
  Nextcloud's web UI) see only ciphertext. Maximum confidentiality; humans can't edit the files
  directly (they'd corrupt the ciphertext). Use for anything sensitive.
- **`none`** — files are stored plaintext. A human can **open, edit, and manage them directly in the
  storage UI** (Nextcloud, etc.) and the silo reflects those edits live. Trades confidentiality for
  direct human collaboration. Use for shared/project data where transparency is the point.

Because it's a signed manifest field, the encryption posture is owner-set and tamper-evident like the
rest of the policy. A backup can still wrap even a `none` silo under the backup root key in transit.

### The invariant: only the owner mints new peers

**Granting a NEW peer is always an owner-only operation — never delegable to a guard, ever.** A guard
(inline today, standalone later) may only *serve* grants the owner already minted (existing
capability + pre-wrapped content key), which it can do offline **without ever seeing plaintext**.
Creating a new trust relationship requires the owner. This bounds guard trust: a compromised guard can
disrupt or deny, but it can **never manufacture access for someone the owner never blessed.**

### Control plane vs. data plane (the owner is not a bandwidth bottleneck)

Authorization and bulk transfer are separated:

- **Control plane (owner's guard):** authenticate + authorize + mint a short-lived, scoped,
  owner-signed capability + connection info. Tiny, cheap.
- **Data plane (direct peer ↔ storage node):** the peer presents the capability *directly* to the node
  holding the bytes, which verifies it and streams. The owner is **out of the transfer path** — crucial
  for silos holding video/audio, and so a small owner box never proxies gigabytes.

Two transport tiers, same `shared/storage.js` abstraction underneath:
- **Publicly-reachable storage (S3/R2/Nextcloud URL)** — the guard mints a **presigned/capability
  URL**; the peer fetches direct. Works today, trivially — the MVP.
- **NAT'd / self-hosted node** — the guard is the **signaling broker**; the two sides **hole-punch** a
  direct connection with a **relay fallback**. Candidate stack: **libp2p** (Ed25519 peer identity, NAT
  traversal/DCUtR hole-punching, circuit-relay) or WebRTC data channels. Horizon, not MVP.

The direct channel stays safe: the capability is owner-signed + short-TTL + offline-verifiable, the
content is E2E-encrypted (ciphertext in transit), and the channel is DTLS/TLS.

### Future: guard agents as a federation "sentinel" role

The guard is designed as a **separable responsibility** from day one (authenticate → check ledger →
mint/serve capability → audit → honor kill switches), even though the owner runs it inline at first.
That makes a later extraction into **standalone guard agents** a near-free forward-compat move. A
federation of guards could then provide **owner-offline availability** (serving already-minted grants)
and **M-of-N threshold** authorization (no single guard is a point of compromise) — a specialized
`FEDERATION.md` "sentinel" role whose sole goal is data-access sanctity. Bounded by the invariant
above: guards serve existing trust, they never mint new trust.

## The Self silo — the default artifact home & session awareness

The Self silo (created from the `self` template) is the **default birthplace of every artifact**. For
that to hold, *every session must know it exists and how to use it* — otherwise the agent scatters
files across the system. Three reinforcing layers, weakest → strongest:

1. **Awareness (prompt injection).** The core already injects the identity anchor + `ASMLTR TOOLBELT`
   into every turn (`core/src/server.js`). Add a compact **SELF SILO** block: the root, the `asmltr
   silo` verbs, and the rule — *"create artifacts here by default; you can work elsewhere when the task
   requires it — just leave a pointer."* Teach the commands, not the data (query live; never dump the
   tree into the prompt).
2. **Gravity (default cwd).** The strongest nudge is `pwd`. Terminal (`asmltr claude`) + channel-turn
   cwd default into a silo workspace, so relative writes land in the silo without the agent thinking
   about it. Explicit "work on repo X" overrides it. Gravity well, not jail.
3. **Capture (automatic).** A filesystem watcher auto-indexes anything created (same pattern as the
   a filesystem watcher); the claude-code `PostToolUse` hook auto-records an `external_ref` pointer when
   a `Write`/`Edit` lands *outside* the silo. So "99% captured" survives agent forgetfulness — the
   agent's `put --tags` is enrichment, not something we depend on.

Sessions are parts; the silo is the shared body — a part that makes a PDF drops it in the silo where a
future part (or the observer/whole) finds it via `asmltr silo find`. Proprioception for artifacts,
the same shape as the `asmltr who <path>` / body-schema graph already built.

## Integrations & storage backends

**Vocabulary (project-wide from here on):** a **connector** is an I/O channel the agent uses to talk to
a *human* (Discord, Telegram, email, web, MCP, GitHub, CLI). An **integration** is a link to a
*third-party service* (storage, backups, or any user-added API). The GUI's current "Integrations" view
manages connectors → it should be renamed **Connectors**, freeing "Integrations" for this.

### The integrations framework

Parallel to the connector framework but simpler — integrations are **not** long-running supervised
processes; they're **config + a driver** loaded on demand. So: a **registry** (config + vault-referenced
credentials), driver modules under `integrations/types/<type>/`, and a config/test API. Every
integration's credentials live in the **TRUST vault**. Until P2, they resolve through the existing
`shared/secrets.js` abstraction, so the framework can be built before the vault lands.

### Storage backends (the first integrations) — `shared/storage.js`

The driver contract (`put/get/stat/list/remove/move/mkdir/mint`) is defined in `shared/storage.js`
(built-in `local` driver done). Two categories:

- **Managed object / cloud storage** — account + keys → ready, no box to run. **S3-compatible** covers
  **AWS S3, Backblaze B2, DigitalOcean Spaces, Cloudflare R2, MinIO** with one driver + an endpoint
  setting; **Dropbox** and **Google Drive** have their own APIs (separate drivers). `mint()` returns a
  **presigned URL** for the direct data plane.
- **Self-hosted storage node** — a Linux box (existing, or provisioned) running **WebDAV** or **SSH/SFTP**.

### Provisioning — "give me SSH, I'll build you a storage node"

Distinct from *transport* (how you talk to storage) and *silo* (the data on top). Layered:

1. **Provisioner (create infra):**
   - **`ssh`** — the universal primitive: given SSH access (user + password/key) to an existing Linux
     box, install + configure a storage service (WebDAV or SFTP) + a scoped account + firewall.
   - **`digitalocean` / `aws`** — *extend* the ssh provisioner: first **create a box** via the provider
     API per defined settings (size/region/image), then hand off to `ssh` to configure it. (Pure object
     storage — S3/Spaces/B2 — skips this: no box to provision, just a bucket + keys.)
2. **Transport** — the resulting `shared/storage.js` driver (`webdav`/`sftp`/`s3`).
3. **Silo** — created on that transport; backups can target it.

So `asmltr` can stand up a fresh self-hosted storage node from nothing but provider creds (or bare SSH),
then register it as a storage integration a silo/backup can use.

### Custom integrations (user-extensible, no code)

A generic integration a human adds through a GUI plane: **base URL + auth (API key in the vault) +
usage examples / API-docs link**. These are surfaced to the *agent* (injected like the toolbelt, or
`asmltr integration docs <name>`) so it learns to call the service — key injected use-but-never-see via
the vault. A no-code way to hand the agent new capabilities.

## Phased roadmap

- **P0 — Substrate & vault dependency.** `shared/storage.js` (local + Nextcloud/WebDAV); `shared/secrets.js`
  trust-protocol provider (use-but-never-see proxy + SACRED raw-fetch for protocol secrets; de-BWS);
  hard-dependency boot wiring + lock/health status.
- **P1 — Auth layer.** Local operator auth (Argon2id + TOTP + WebAuthn passkey), sessions, rate-limit/
  lockout, login screen; OIDC relying-party config. Coexists with (doesn't require) Authelia.
- **P2 — Vault unlock + credentials view.** Login↔vault envelope-wrapping; degraded-but-loud locked
  state; Settings → Vault (list keys + metadata + audit, add/rotate/delete, per-key tier — never values).
- **P3 — Self silo + artifact-home.** The silo construct (`.silo/` signed manifest, templates, no
  default zones); file-manager verbs + L0/L1 search over `shared/storage.js`; the derived search index
  (watcher) + external-ref capture (PostToolUse hook); the three-layer awareness (SELF SILO injection +
  default cwd gravity + auto-capture); the Self silo from the `self` template; migrate identity +
  relationships + transcripts + state under it.
- **P4 — Backups.** `scripts/backup.js` (consistent SQLite `.backup()`, append-only transcript sync,
  re-seal vault, encrypted archive + manifest); restore via setup.d + rehydrate + verify-restore;
  auto-snapshot before every self-update; CLI + Settings → Backup.
- **P5 — Project silos + trust-gated access.** Provision templated silos; the guard (reference monitor,
  designed as a separable role); owner-signed manifests + grants-in-the-owner's-ledger; control/data-
  plane split with presigned/capability-URL data plane (MVP); peer connect scoped by grant, revocable
  via TRUST kill switches. **Invariant: only the owner mints new-peer grants.** Horizon: libp2p
  hole-punched data plane + standalone/threshold guard agents ("sentinel" federation role).
- **P6 — Dreaming / sleep.** Scheduled compaction: raw history → abstracted memory artifacts
  (summaries + embeddings → eve-search) stored back in the silo. Raw is never touched; regenerable.

## Relationship to existing tickets

- **#25 (Backup system)** → P4 (+ the storage-backend substrate in P0).
- **#26 (Data silos)** → P3 + P5 (+ storage backends in P0).
- Builds on shipped work: the identity anchor (P3 awareness), `shared/secrets.js` provider pattern
  (P0), `setup.d` + applied-ledger (P4 restore), the cast/trust store + TRUST tiers (P2/P5).
