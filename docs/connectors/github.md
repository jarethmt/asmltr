# GitHub connector

The GitHub connector (`connectors/types/github/index.js`) is a **mention-driven, repo-aware issue
assistant**. It watches configured repositories and only wakes when a comment or issue body
literally contains its trigger token. It never replies to anything untagged and never acts
autonomously.

---

## How it works

- **Mention-driven.** The connector polls each repo's recent issue comments and freshly-updated
  open issue bodies. A message wakes the assistant only if it contains the `mention` token (the
  match ignores tokens embedded in words, so an email like `me@example.com` won't trigger it).
- **Persistent per-issue sessions.** Each issue is its own conversation, so re-invoking the trigger
  on the same issue continues the same thread with full prior context.
- **Repo-aware.** Each repo is shallow-cloned locally and the session's working directory is set to
  the clone, so the model reasons about the *actual* code, not just the issue text.
- **Live-updating comment.** On invocation the connector posts one placeholder comment and
  live-edits it as the turn streams — thinking and tool steps in collapsed `<details>` sections —
  then swaps in the final answer. Long traces spill across a few continuation comments.
- **Own identity.** The connector authenticates as *its own* GitHub account via its PAT (never the
  host's default `gh`/git auth). It tracks the comment ids it authors so it never treats its own
  comments as triggers — meaning a human can safely post from the same bot account.
- **Redaction.** Every comment body is scrubbed for secrets before posting, because issue comments
  are a public surface.

!!! warning "Advisory only (v1)"
    The connector proposes changes and can do explicitly-requested GitHub housekeeping (close an
    issue, add a label, comment) as its own account. It does **not** push commits, open PRs, or
    merge.

---

## Conversation key

```
github:<instanceId>:repo:<owner/repo>:issue:<n>
```

---

## Configuration

Discoverable live at `GET /types` on the manager. From the connector's `configSchema`:

| Field | Default | Purpose |
|---|---|---|
| `repos` | — | List of `{ owner, repo }` to watch (**required**). |
| `pat_bws_key` | — | Secret key name for this account's GitHub PAT (**required**). |
| `mention` | `*<assistant-name>` | Literal trigger token that wakes the assistant (e.g. `@bot`). |
| `poll_interval_ms` | `20000` | How often to poll each repo. |
| `workspace_dir` | `~/.asmltr/github-repos` | Where repos are shallow-cloned. |
| `clone_repos` | `true` | Clone repos for code-awareness. |
| `stream` | `true` | Live-stream the working comment (ignored in dry run). |
| `dry_run` | `true` | Log intended actions instead of posting. |

!!! note "The PAT is a secret key name"
    `pat_bws_key` names a secret in your configured secret store — not the raw PAT. The account the
    PAT authenticates as is the identity the connector posts as.

---

## Start in dry run

!!! tip "Recommended first run: `dry_run: true`"
    `dry_run` defaults to `true`. Leave it on until you've confirmed the connector triggers on the
    right mentions and produces sensible answers — in dry run it logs what it *would* post without
    touching the repo. Flip it to `false` to go live.

---

## Create an instance

```bash
curl -s -X POST 127.0.0.1:3024/instances -H 'Content-Type: application/json' -d '{
  "type":"github",
  "name":"my-repo-bot",
  "enabled":true,
  "config":{
    "pat_bws_key":"my_github_pat",
    "mention":"@bot",
    "repos":[{"owner":"my-org","repo":"my-repo"}],
    "dry_run":true
  }
}'
```

Once you're happy with the dry-run logs, `PATCH` the instance with `dry_run:false` (remember to
send the **full** config):

```bash
curl -s -X PATCH 127.0.0.1:3024/instances/<id> -H 'Content-Type: application/json' -d '{
  "config":{
    "pat_bws_key":"my_github_pat",
    "mention":"@bot",
    "repos":[{"owner":"my-org","repo":"my-repo"}],
    "dry_run":false
  }
}'
```

See [Connectors](index.md) for the full manager API.
