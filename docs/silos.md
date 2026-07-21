# Data silos & the Self silo

A **silo** is a self-describing, migratable data container — the unit behind the assistant's memory
and its project workspaces. The design intent (encryption, ownership, federation) lives in the
[roadmap](ROADMAP-VAULT-SILOS-BACKUP.md); this page documents what's **shipped** (v0.5.0+).

## What makes a directory a silo

A directory is a silo **iff** it carries a `.silo/manifest.json` marker — exactly like `.git/` makes a
directory a repo. The manifest records identity + provenance:

```json
{ "id": "self", "name": "Assistant — Self", "type": "self",
  "manifest_version": 1, "created_with": "0.5.0", "min_asmltr": "0.5.0",
  "created_at": 1752633600000, "storage": { "backend": "local" } }
```

Two principles hold the model together:

- **The filesystem is the schema.** Discovery is search over the *real files*; any index is a
  rebuildable accelerator, never the source of truth. Nothing breaks if you edit files directly.
- **Structure comes from a template at creation — there are no enforced zones.** A template just seeds
  folders as a convenient default home; the silo is free-form afterward. Recall is guaranteed by
  *search*, not by convention.

Silos are **local-first**: file ops + search go through the [`shared/storage.js`](integrations/index.md)
driver, so a silo is backend-agnostic (local today; a silo can live on WebDAV/S3, encrypted, later).

### Templates

| Template | Seeded zones |
|----------|--------------|
| `self` | `artifacts/`, `workspaces/`, `memory/{identity,transcripts,dreams}` |
| `software-project` | `src/`, `docs/`, `artifacts/` |
| `research` | `sources/`, `notes/`, `findings/` |
| `media` | `images/`, `audio/`, `video/`, `docs/` |
| `generic` | *(none)* |

## The Self silo

The **Self silo** (type `self`) is special: it's the assistant's own memory **and the default home for
everything it creates**. The core ensures it exists at boot (`silo.ensureSelf(<name>)`), and injects a
**SELF SILO** block into every session's system prompt teaching the convention:

> When you produce an artifact and the task doesn't specify where, create it **under the Self silo** —
> don't scatter files in random system paths. Browse/recall past work with `asmltr silo …`.

So an artifact has a home by default, and past work is *recall*able rather than lost — without forcing
any single directory layout on the agent.

By default the Self silo lives at `~/.asmltr/silos/self` (override the root with `ASMLTR_SILOS_ROOT`).

## The `asmltr silo` CLI

All verbs default to the **Self silo**; add `--silo <id>` to target another.

```bash
asmltr silo overview                 # map: id, type, zones, file count
asmltr silo ls [path]                # list a directory
asmltr silo tree [path] [--depth N]  # recursive tree
asmltr silo find <query> [--content] [--type <ext>] [--since <date>] [--in <subpath>]
asmltr silo get <path>               # print a file
asmltr silo put <path> [file]        # write a file (2nd arg = source; else stdin)
asmltr silo stat <path>
asmltr silo mkdir|rm|mv <path> [dest]
asmltr silo list                     # every silo under the root
asmltr silo new <id> [--name "…"] [--template <type>]
```

### Search

`find` is **layered**:

- **L0 — metadata** (always): filename substring + `--type <ext>` + `--since <date>` filters.
- **L1 — content** (`--content`): full-text keyword search across text files. Uses **ripgrep** when
  available (fast), and falls back to a **pure-JS scan** of text files when `rg` isn't on `PATH` — so
  content search always works. Each hit is tagged `name`, `content`, or `name+content`.

## The Silos GUI

The dashboard **Silos** view is a file explorer over the same construct:

- a **silo rail** listing every silo — select one, **add** a new silo (pick a template), or open **Settings**;
- a **breadcrumb browser** with a directory listing (folders first), **new folder** + **upload**, and per-entry delete;
- a **file preview/editor** — text files open in an editable pane with **Save**; binaries show a size notice;
- **layered search** — a filename search with a **full-text** toggle (the L1 content search);
- a **Settings** modal to edit the manifest (name, description) and **delete the silo** (confirmed; the Self
  silo is protected);
- a **relationship-graph** teaser — the scaffold for a future node graph of links *within and across* silos
  (files are nodes; references/provenance become edges).

It's backed by `/v2/silos*` on the core (list/overview/ls/tree/find/file + mkdir/put/mv/rm + create/patch/delete),
the same operations the CLI exposes.

## See also

- [Integrations & storage](integrations/index.md) — the storage driver contract + encryption-at-rest.
- [Roadmap: Vault · Auth · Self Silo · Data Silos · Backups](ROADMAP-VAULT-SILOS-BACKUP.md) — the full
  design, including per-silo encryption, owner-gated access, and the federation guard model.
