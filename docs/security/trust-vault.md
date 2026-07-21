# TRUST vault — credentials & KMS

asmltr uses the **[TRUST Protocol](https://github.com/jarethmt/trust-protocol)** as its secret store.
TRUST is a standalone credential broker + trust infrastructure for AI agents; asmltr adopts it as a
dependency rather than reinventing one.

- **Repo:** <https://github.com/jarethmt/trust-protocol>
- **Docs:** <https://agitrust.network/> — see the [Credential Proxy](https://agitrust.network/guides/credential-proxy/)
  and [KMS](https://agitrust.network/guides/kms/) guides.

## Why

An agent's credentials should not sit in plaintext env files or leak into a model's context. The vault
gives asmltr two complementary capabilities:

- **Credential broker (use-but-never-see)** — for API keys the agent should never touch: the vault
  injects them into outbound calls; the agent sends `{{CREDENTIAL}}`, the vault substitutes the value.
- **KMS (envelope encryption)** — for keys asmltr must use *itself* to encrypt its own data at rest
  (silos, backups). The vault's master key never leaves the vault; asmltr holds only a **wrapped** blob
  and unwraps on demand. asmltr contributed the KMS *to* TRUST Protocol.

The vault also encrypts everything at rest with AES-256-GCM, keeps a tamper-evident audit chain, and
supports trust tiers + instant kill switches.

## Is it required?

**Adopting the vault is opt-in per install.** asmltr's secret resolution only uses the vault when
`ASMLTR_VAULT_URL` **and** `ASMLTR_VAULT_AGENT_KEY` are set; otherwise it falls back to the environment
/ secrets file / command provider (see [Secrets & config](secrets.md)). So an install without the vault
keeps working unchanged. Once you enable it, it becomes the primary store and you can retire the others.

## Enabling it

!!! tip "Guided path — `asmltr vault init`"
    Once the vault is **running** (step 1 below) and you have its admin key, one command does steps 2–3:
    ```bash
    asmltr vault init --url http://127.0.0.1:9500/v1 --admin-key <admin key> [--unseal <passphrase>]
    ```
    It health-checks the vault, unseals it if needed, registers the assistant as a **SACRED** agent,
    writes `ASMLTR_VAULT_*` to `.env`, and verifies a `store → proxy-fetch → delete` roundtrip. It points
    at an existing vault — it won't silently stand up a security service. `asmltr vault status` shows
    reachability + seal state at any time. The manual steps below are the same thing, spelled out.

### 1. Run the vault

The vault is a small Python service (Docker) on `127.0.0.1:9500`:

```bash
git clone https://github.com/jarethmt/trust-protocol
cd trust-protocol
# strong, stable secrets so the vault auto-unseals on restart (dev/auto-unseal mode)
cat > docker-compose.override.yml <<YML
services:
  trust-protocol:
    environment:
      - TRUST_PROTOCOL_ADMIN_KEY=$(openssl rand -hex 32)
      - TRUST_PROTOCOL_VAULT_PASSWORD=$(openssl rand -hex 32)
YML
docker compose up -d --build
curl -s http://127.0.0.1:9500/v1/health   # {"status":"ok","sealed":false}
```

> **Sealed vs. unsealed.** The vault seals at rest. Unseal it with the master passphrase from asmltr —
> `asmltr vault unseal <passphrase>`, or the **Vault** plane's inline unseal form when the banner shows
> "sealed" (the passphrase is held only in the vault's memory, never persisted). In dev,
> `TRUST_PROTOCOL_VAULT_PASSWORD` auto-unseals
> on start. **Back up the admin key + vault password** — they're the root of trust and can't live in the
> vault itself.

### 2. Register the assistant as an agent

The agent that holds keys **is** the assistant's identity. Register it under the assistant's name and
promote it to **SACRED** (the tier that may touch credentials + the KMS):

```bash
ADMIN=<TRUST_PROTOCOL_ADMIN_KEY>
REG=$(curl -s -X POST http://127.0.0.1:9500/v1/agents -H "X-Admin-Key: $ADMIN" \
  -H 'Content-Type: application/json' -d '{"name":"<AssistantName>","agent_type":"assistant"}')
AID=$(echo "$REG" | jq -r .agent_id); AKEY=$(echo "$REG" | jq -r .api_key)   # api_key returned ONCE
curl -s -X PATCH http://127.0.0.1:9500/v1/agents/$AID/trust-level -H "X-Admin-Key: $ADMIN" \
  -H 'Content-Type: application/json' -d '{"trust_tier":"SACRED"}'
```

(`shared/vault.js` also exports `ensureAgent(name)` to do this idempotently on a fresh install.)

### 3. Point asmltr at the vault

Add the access keys to `.env` — the **one bootstrap root** that can't live in the vault:

```bash
ASMLTR_VAULT_URL=http://127.0.0.1:9500/v1
ASMLTR_VAULT_ADMIN_KEY=<admin key>   # store/manage credentials + agents
ASMLTR_VAULT_AGENT_KEY=<agent key>   # this assistant's SACRED agent (retrieval + KMS)
```

Restart the host services. `GET /v2/vault/status` (and the dashboard's **Vault** plane) now report
`{ configured, reachable, sealed }`.

## Storing & using secrets

Once configured, `secrets.get('<name>')` resolves from the vault first. Store credentials via the
dashboard **Vault** plane (Add secret → name + value + tier), the CLI, or the API:

```bash
curl -s -X POST http://127.0.0.1:3023/v2/vault/secrets -H 'Content-Type: application/json' \
  -d '{"name":"openai_api_key","value":"sk-…","min_trust":"SACRED"}'
```

Values are **write-only from asmltr's control surfaces** — the dashboard never displays a secret's
value, only its name, tier, and access count. Retrieval is the SACRED core's job (via single-use
proxy-value tokens), not the UI's.

## De-BWS / migrating an existing install

If your install currently resolves secrets from another provider (e.g. Bitwarden via
`ASMLTR_SECRET_CMD`), enabling the vault is additive: the vault is tried first, the old provider is the
fallback. Migrate at your pace — copy each secret into the vault, verify it resolves, then disable the
old provider. On a reference install every runtime secret (connector tokens + voice keys) lives in
the vault and the Bitwarden provider is off.

## KMS (encryption-at-rest)

The vault's KMS wraps/unwraps the per-silo data keys used by
[EncryptedStorage](../integrations/index.md#encryption-at-rest). The master key never leaves the vault;
the plaintext data key lives only transiently in asmltr's runtime crypto layer — never in the model's
context — and is zeroed after use. See the [KMS guide](https://agitrust.network/guides/kms/).
